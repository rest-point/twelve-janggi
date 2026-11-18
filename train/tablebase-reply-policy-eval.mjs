import { readFileSync, writeFileSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { applyAction, initialState, isLegalAction, legalActions } from '../src/engine.js';
import { loadRegistry, percentile, rng, seedOf } from '../bench/common.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { classify, openTable } from '../models/tbrl-core.mjs';

const baseline = 'tbrl-v2';
const candidate = new URL('../models/tablebase-reply-mlp-v1.mjs', import.meta.url);
const variants = {
  policy: { maxTimeMs: 25 },
  uniform: { maxTimeMs: 25, uniformMix: 1 },
  avoid: { maxTimeMs: 25, continuation: 1 },
  blend: { maxTimeMs: 25, avoidRepeat: true, replyWeight: 0.75 },
  soft: { maxTimeMs: 25, avoidRepeat: true, replyWeight: 0.4 },
  longer: { maxTimeMs: 25, avoidRepeat: false, replyWeight: 0.15 },
  late: { maxTimeMs: 25, profileFromPly: 24, avoidRepeat: true, replyWeight: 0.8, novelty: 0.5 },
  lateSoft: { maxTimeMs: 25, profileFromPly: 32, avoidRepeat: true, replyWeight: 0.5, novelty: 0.5 },
  lateExplore: { maxTimeMs: 25, profileFromPly: 26, replyWeight: 0.8, novelty: 1, continuation: 0.8 },
};

function openings(size, depth, seed, excluded) {
  const result = [], visited = new Set(excluded), random = rng(seed), table = openTable();
  try {
    if (depth === 0) return Array.from({ length: size }, () => initialState());
    for (let trial = 0; trial < size * 1000 && result.length < size; trial++) {
      let state = initialState();
      const target = depth + Math.floor(random() * 6);
      while (state.ply < target) {
        const choices = classify(state, legalActions(state), table).filter(c => c.value === 0 && !c.terminal && c.repeat < 2);
        if (!choices.length) break;
        state = applyAction(state, choices[Math.floor(random() * choices.length)].action, false);
      }
      const key = new FastPosition(state).key();
      if (state.ply >= depth && !visited.has(key)) { result.push(state); visited.add(key); }
    }
    if (result.length !== size) throw new Error('Insufficient distinct drawn openings');
    return result;
  } finally { table.close(); }
}

async function play(job, models) {
  const ours = models[job.model], theirs = models[job.opponent], times = [], moves = [];
  let state = job.start;
  while (state.winner === null && state.ply < 256) {
    const ourTurn = state.turn === job.side;
    const model = ourTurn ? ours : theirs;
    const actions = legalActions(state);
    const request = { state, legalActions: actions, budgetMs: 60000, config: model.config,
      seed: seedOf(job.seed, state.ply, state.turn) };
    const start = performance.now();
    const { action } = await model.think(request);
    const elapsed = performance.now() - start;
    if (!isLegalAction(state, action)) throw new Error('Illegal move by ' + (ourTurn ? job.model : job.opponent));
    if (ourTurn) times.push(elapsed);
    state = applyAction(state, action, false);
    moves.push(action);
  }
  return { ...job, times, moves, winner: state.winner ?? 'draw', termination: state.termination ?? 'max-plies' };
}

if (!isMainThread) {
  const models = {};
  for (const m of workerData) models[m.id] = { think: (await import(m.url)).think, config: m.config };
  parentPort.on('message', async job => parentPort.postMessage(await play(job, models)));
} else {
  const [out, names, count, depth, seed, policy = 'registered', dataset] = process.argv.slice(2);
  const opponents = names?.split(',') ?? [];
  const registry = await loadRegistry();
  const groups = { screen: ['policy', 'uniform', 'avoid'], 'blend-screen': ['blend', 'soft', 'longer'],
    'late-screen': ['late', 'lateSoft', 'lateExplore'] };
  const wanted = groups[policy] ?? [policy];
  if (!out || !opponents.length || !Number.isSafeInteger(Number(count)) || Number(count) < 1
    || !Number.isSafeInteger(Number(depth)) || Number(depth) < 0 || !Number.isSafeInteger(Number(seed))
    || !wanted.every(name => name === 'registered' || Object.hasOwn(variants, name))) {
    throw new Error('Specify output, opponents, count, depth, seed and variant');
  }
  const excluded = dataset ? JSON.parse(readFileSync(dataset, 'utf8')).map(row => row.board) : [];
  const starts = openings(Number(count), Number(depth), Number(seed), excluded);
  const modelIds = [baseline, ...wanted];
  const manifests = [baseline, ...opponents].map(id => {
    const model = registry.find(m => m.id === id);
    if (!model) throw new Error('Unknown model ' + id);
    return { id, url: pathToFileURL(model.entryPath).href, config: model.config };
  });
  for (const variant of wanted) {
    const config = variant === 'registered' ? registry.find(model => model.id === 'tablebase-reply-mlp-v1')?.config : variants[variant];
    if (!config) throw new Error('Missing registered candidate');
    manifests.push({ id: variant, url: candidate.href, config });
  }
  const jobs = starts.flatMap((start, index) => opponents.flatMap(opponent => [0, 1].flatMap(side => modelIds.map(model => ({
    model, opponent, side, start, index, seed: seedOf(seed, index, opponent),
  })))));
  const workers = [], results = [];
  let next = 0;
  try {
    await new Promise((resolve, reject) => {
      for (let i = 0; i < Math.min(7, jobs.length); i++) {
        const worker = new Worker(new URL(import.meta.url), { workerData: manifests });
        workers.push(worker);
        worker.on('error', reject);
        worker.on('exit', code => { if (results.length < jobs.length) reject(new Error('Worker exited ' + code)); });
        worker.on('message', result => {
          results.push(result);
          if (results.length % 8 === 0) console.log(results.length + '/' + jobs.length);
          if (results.length === jobs.length) resolve();
          else if (next < jobs.length) worker.postMessage(jobs[next++]);
        });
        worker.postMessage(jobs[next++]);
      }
    });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  const report = modelIds.flatMap(model => [...opponents, null].map(opponent => {
    const games = results.filter(g => g.model === model && (!opponent || g.opponent === opponent));
    const wins = games.filter(g => g.winner === g.side).length, draws = games.filter(g => g.winner === 'draw').length;
    const times = games.flatMap(g => g.times);
    return { model, opponent, games: games.length, wins, draws, losses: games.length - wins - draws,
      winRate: wins / games.length, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95) };
  }));
  const baselineWins = new Map(results.filter(game => game.model === baseline)
    .map(game => [JSON.stringify([game.index, game.side, game.opponent]), Number(game.winner === game.side)]));
  const paired = wanted.map(model => {
    const blocks = starts.map((_, index) => {
      const games = results.filter(game => game.model === model && game.index === index);
      return games.reduce((sum, game) => sum + Number(game.winner === game.side)
        - baselineWins.get(JSON.stringify([index, game.side, game.opponent])), 0) / games.length;
    });
    const random = rng(seedOf(seed, 'paired-win-rate'));
    const samples = Array.from({ length: 10000 }, () => blocks.reduce(sum => sum
      + blocks[Math.floor(random() * blocks.length)], 0) / blocks.length);
    return { model, openingBlocks: blocks.length, winRateDelta: blocks.reduce((a, b) => a + b, 0) / blocks.length,
      interval95: Number(depth) > 0 ? [percentile(samples, 0.025), percentile(samples, 0.975)] : null };
  });
  writeFileSync(out, JSON.stringify({ seed: Number(seed), depth: Number(depth), report, paired, games: results }));
  for (const row of report) console.log(JSON.stringify(row));
  for (const row of paired) console.log(JSON.stringify(row));
}
