import { Worker } from 'node:worker_threads';
import { mkdir, open, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ROOT, loadRegistry, makeJob, summarize, sha256 } from './common.mjs';
import { RULESET } from '../src/engine.js';

function parseArgs(args) {
  const options = { a: 'greedy-v1', b: 'random-v1', games: 100, concurrency: 2, seed: 20261031, moveMs: 60000, maxPlies: 256, openingPlies: 4 };
  const names = { '--a': 'a', '--b': 'b', '--games': 'games', '--concurrency': 'concurrency', '--seed': 'seed', '--move-ms': 'moveMs', '--max-plies': 'maxPlies', '--opening-plies': 'openingPlies' };
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]], raw = args[i + 1];
    if (!name || raw === undefined) throw new Error(`Unknown/missing option: ${args[i]}`);
    options[name] = ['a', 'b'].includes(name) ? raw : Number(raw);
  }
  for (const [key, min, max] of [['games', 4, 100000], ['concurrency', 1, 32], ['seed', 0, 4294967295], ['moveMs', 1, 60000], ['maxPlies', 1, 4096], ['openingPlies', 0, 32]]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key}: ${options[key]}`);
  }
  if (options.games % 4 !== 0) throw new Error('--games must be a multiple of 4');
  if (options.a === options.b) throw new Error('Use two distinct model version IDs');
  options.concurrency = Math.min(options.games, options.concurrency);
  return options;
}

const workers = [];
let file, writeChain = Promise.resolve(), interrupted = false;
try {
  const options = parseArgs(process.argv.slice(2));
  const registry = await loadRegistry();
  const models = [options.a, options.b].map(id => {
    const model = registry.find(m => m.id === id);
    if (!model) throw new Error(`Unknown model: ${id}; available: ${registry.map(m => m.id).join(', ')}`);
    return model;
  });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const out = path.join(ROOT, 'artifacts', runId);
  await mkdir(out, { recursive: true });
  const config = {
    runId, createdAt: new Date().toISOString(), ruleset: RULESET, options,
    models: models.map(({ entryPath, ...model }) => model),
    engineHash: sha256(await readFile(path.join(ROOT, 'src/engine.js'))),
    runnerHash: sha256(await Promise.all(['common.mjs', 'run.mjs', 'referee.mjs', 'model-worker.mjs', 'game-worker.mjs'].map(name => readFile(new URL(name, import.meta.url), 'utf8'))).then(parts => parts.join('\n'))),
    environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
  };
  config.configHash = sha256(JSON.stringify(config));
  await writeFile(path.join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  file = await open(path.join(out, 'games.jsonl'), 'wx');
  const games = [];
  let next = 0, completed = 0;
  const started = performance.now();
  console.log(`Run ${runId}: ${options.a} vs ${options.b}, ${options.games} games, concurrency ${options.concurrency}`);
  console.log(`Output: ${out}`);
  await new Promise((resolve, reject) => {
    const interrupt = () => { interrupted = true; reject(new Error('Interrupted; partial games.jsonl retained. Run is incomplete.')); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
    const fail = error => { cleanup(); reject(error); };
    const assign = worker => {
      if (next < options.games) worker.postMessage(makeJob(next++, options));
    };
    for (let slot = 0; slot < options.concurrency; slot++) {
      const worker = new Worker(new URL('./game-worker.mjs', import.meta.url), { workerData: { models, options } });
      workers.push(worker);
      worker.on('error', fail);
      worker.on('exit', code => { if (completed < options.games && !interrupted) fail(new Error(`Game worker exited (${code}); infrastructure failure, run incomplete`)); });
      worker.on('message', async message => {
        try {
          if (message.infraError) throw new Error(`Infrastructure failure: ${message.infraError}; run incomplete`);
          const game = { ...message.game, runId, configHash: config.configHash };
          writeChain = writeChain.then(() => file.write(JSON.stringify(game) + '\n'));
          await writeChain;
          games.push(game); completed++;
          if (completed % Math.max(4, Math.floor(options.games / 10)) === 0 || completed === options.games) console.log(`${completed}/${options.games}`);
          if (completed === options.games) { cleanup(); resolve(); } else assign(worker);
        } catch (error) { fail(error); }
      });
      assign(worker);
    }
  });
  const summary = { runId, configHash: config.configHash, a: options.a, b: options.b, ...summarize(games, performance.now() - started) };
  summary.participants = [
    { modelId: options.a, wins: summary.wins, draws: summary.draws, losses: summary.losses, winRate: summary.winRate, scoreRate: summary.scoreRate, modelFailures: summary.modelFailureCounts.a, timing: summary.timing.a },
    { modelId: options.b, wins: summary.losses, draws: summary.draws, losses: summary.wins, winRate: summary.losses / summary.games, scoreRate: 1 - summary.scoreRate, modelFailures: summary.modelFailureCounts.b, timing: summary.timing.b },
  ];
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const percent = n => `${(n * 100).toFixed(2)}%`;
  const report = `# ${runId}\n\nA: ${options.a}, B: ${options.b}\n\n` +
    `| Model | W | D | L | Win rate | Score rate | Failures |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
    summary.participants.map(p => `| ${p.modelId} | ${p.wins} | ${p.draws} | ${p.losses} | ${percent(p.winRate)} | ${percent(p.scoreRate)} | ${p.modelFailures} |`).join('\n') + '\n\n' +
    `- A W/D/L: ${summary.wins}/${summary.draws}/${summary.losses} (${summary.games} games)\n` +
    `- A win rate: ${percent(summary.winRate)}, score rate: ${percent(summary.scoreRate)}\n` +
    `- Unique opening keys: ${summary.uniqueOpenings}; opening plies: ${options.openingPlies}\n` +
    `- Model failures: ${summary.modelFailures}, rate: ${percent(summary.modelFailureRate)}\n` +
    `- Throughput: ${summary.gamesPerSecond.toFixed(2)} games/s; wall: ${(summary.wallMs / 1000).toFixed(2)} s\n` +
    `- A p50/p95: ${summary.timing.a.p50Ms?.toFixed(3)}/${summary.timing.a.p95Ms?.toFixed(3)} ms\n` +
    `- B p50/p95: ${summary.timing.b.p50Ms?.toFixed(3)}/${summary.timing.b.p95Ms?.toFixed(3)} ms\n` +
    `- Seed: ${options.seed}, move budget: ${options.moveMs} ms, max plies: ${options.maxPlies}, concurrency: ${options.concurrency}\n\n` +
    `Descriptive statistics only; no confidence interval or proof of optimality. Repeated opening keys are not independent samples. See summary.json for color/first-player breakdown and termination reasons.\n\n` +
    `Config hash: ${config.configHash}\n`;
  await writeFile(path.join(out, 'report.txt'), report);
  console.log(`A W/D/L ${summary.wins}/${summary.draws}/${summary.losses}; score ${percent(summary.scoreRate)}; ${summary.gamesPerSecond.toFixed(2)} games/s`);
  console.log(`Replay archive (npm run dev): http://127.0.0.1:5173/experiments?run=${encodeURIComponent(runId)}`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await Promise.all(workers.map(worker => worker.terminate()));
  await writeChain.catch(() => {});
  await file?.close();
}
