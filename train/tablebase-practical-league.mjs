import { readFileSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { applyAction, initialState, legalActions } from '../src/engine.js';
import { rng, seedOf } from '../bench/common.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { openFullTablebase, denseIndex } from '../models/full-tablebase-v2.mjs';
import { FEATURES, certifiedWin, createPracticalRanker, drawOptions } from '../models/tablebase-practical-ranker-v1.mjs';
import { think as baseline } from '../models/tablebase-minimax-reply-v2.mjs';
import { think as greedy } from '../models/greedy.mjs';
import { think as stockjang } from '../models/stockjang-v1.mjs';
import { think as packed } from '../models/packed-gemm-puct-v2.mjs';
import { think as minimax } from '../models/minimax.mjs';
import { think as mcts } from '../models/team-mcts-v1.mjs';

const training = [
  ['greedy', greedy, {}],
  ['stockjang', stockjang, { maxNodes: 2400, maxDepth: 8, maxTimeMs: 100 }],
  ['packed', packed, { simulations: 192, maxTimeMs: 100, rootProofNodes: 400, leafProofNodes: 8 }],
];
const validation = [
  ['stockjang', stockjang, { maxNodes: 40000, maxTimeMs: 360 }],
  ['packed', packed, { simulations: 3200, maxTimeMs: 360, rootProofNodes: 16000, leafProofNodes: 60,
    replyProofNodes: 800, rootCoverage: 2, cInitRoot: 0.9, rootValuePenalty: 0.15 }],
  ['minimax', minimax, { difficulty: 'normal' }],
  ['team-mcts', mcts, { maxSimulations: 1000, rolloutPlies: 256, thinkMs: 360 }],
];

function samplePositions(count, seed, excluded, table) {
  const random = rng(seed), results = [], seen = new Set(excluded);
  let state = initialState();
  for (let step = 0; step < count * 4000 && results.length < count; step++) {
    if (state.winner !== null || state.ply >= 64) state = initialState();
    const position = new FastPosition(state), actions = legalActions(state);
    const choices = drawOptions(state, actions, table);
    const key = denseIndex(position.board, position.hands, position.turn);
    if (choices.length > 1 && !seen.has(key)) {
      seen.add(key);
      results.push({ key, state });
    }
    const candidates = choices.length && random() < 0.8 ? choices.map(choice => choice.action) : actions;
    state = applyAction(state, candidates[Math.floor(random() * candidates.length)], false);
  }
  if (results.length !== count) throw new Error(`Found only ${results.length} distinct drawn positions`);
  return results;
}

function createWorker(options, checkpoint) {
  const table = openFullTablebase();
  const candidate = checkpoint ? createPracticalRanker(checkpoint, table, baseline) : null;
  const collect = options.mode === 'collect';
  const budgetMs = collect ? 180 : 360;
  const baseConfig = collect ? { maxDepth: 5, maxNodes: 5000, maxTimeMs: 130, tablebaseMaxMs: 60 }
    : { maxTimeMs: 360, tablebaseMaxMs: 32 };
  function play(state, side, ours, opponent, seed, times = []) {
    const start = state.ply;
    while (state.winner === null && state.ply - start < options.horizon) {
      if (collect) {
        const position = new FastPosition(state), raw = table.probe(position);
        const forUs = Math.sign(raw) * (state.turn === side ? 1 : -1);
        if (forUs === 1 && certifiedWin(position, table, raw)) return 1;
      }
      const ourTurn = state.turn === side;
      const request = { state, legalActions: legalActions(state), budgetMs, config: ourTurn ? baseConfig : opponent[2],
        seed: seedOf(seed, state.ply) };
      const started = performance.now(), action = (ourTurn ? ours : opponent[1])(request).action;
      if (!collect && ourTurn) times.push(performance.now() - started);
      state = applyAction(state, action, false);
    }
    const outcome = state.winner === side ? 1 : state.winner === null || state.winner === 'draw' ? 0 : -1;
    return collect ? outcome : { outcome, cutoff: state.winner === null, times };
  }
  return ({ state, key }) => {
    const seed = seedOf(options.seed, key);
    if (collect) {
      const choices = drawOptions(state, legalActions(state), table).map(({ action, features }) => {
        const next = applyAction(state, action, false);
        const wins = training.map(opponent => Number(play(next, state.turn, baseline, opponent, seed) === 1));
        return { features, wins };
      });
      return { key, choices };
    }
    const results = validation.flatMap(opponent => [0, 1].map(side => ({ opponent: opponent[0], side,
      baseline: play(state, side, baseline, opponent, seed), candidate: play(state, side, candidate, opponent, seed) })));
    return { key, results };
  };
}

async function runJobs(jobs, options, checkpoint) {
  const workers = [], results = [];
  let assigned = 0, completed = 0;
  try {
    await new Promise((resolve, reject) => {
      for (let i = 0; i < Math.min(jobs.length, options.workers); i++) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { options, checkpoint } });
        workers.push(worker);
        worker.once('error', reject);
        worker.once('exit', status => { if (completed < jobs.length) reject(new Error(`Worker stopped (${status})`)); });
        worker.on('message', ({ index, result }) => {
          results[index] = result;
          if (++completed % 16 === 0 || completed === jobs.length) console.log(`${options.mode} ${completed}/${jobs.length}`);
          if (completed === jobs.length) resolve();
          else if (assigned < jobs.length) worker.postMessage({ index: assigned, job: jobs[assigned++] });
        });
        worker.postMessage({ index: assigned, job: jobs[assigned++] });
      }
    });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  return results;
}

if (!isMainThread) {
  const execute = createWorker(workerData.options, workerData.checkpoint);
  parentPort.on('message', ({ index, job }) => parentPort.postMessage({ index, result: execute(job) }));
} else {
  const { values } = parseArgs({ options: Object.fromEntries(['mode', 'out', 'dataset', 'checkpoint', 'positions', 'seed', 'workers', 'horizon']
    .map(name => [name, { type: 'string' }])) });
  const options = { mode: values.mode, positions: Number(values.positions), seed: Number(values.seed),
    workers: Number(values.workers ?? 4), horizon: Number(values.horizon ?? 24) };
  if (!['collect', 'validate'].includes(options.mode) || !values.out || options.mode === 'validate' && (!values.dataset || !values.checkpoint)) {
    throw new Error('Specify --mode collect|validate --out FILE and validation --dataset FILE --checkpoint FILE');
  }
  for (const [n, min, max] of [[options.positions, 1, 50000], [options.seed, 0, 2 ** 32 - 1], [options.workers, 1, 16], [options.horizon, 1, 240]]) {
    if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid practical league parameters');
  }
  const excluded = values.dataset ? JSON.parse(readFileSync(values.dataset, 'utf8')).rows.map(row => row.key) : [];
  const checkpoint = values.checkpoint ? JSON.parse(readFileSync(values.checkpoint, 'utf8')) : null;
  const table = openFullTablebase();
  let jobs;
  try { jobs = samplePositions(options.positions, options.seed, excluded, table); }
  finally { table.close(); }
  const rows = await runJobs(jobs, options, checkpoint);
  writeFileSync(values.out, JSON.stringify({ options, features: FEATURES,
    opponents: (options.mode === 'collect' ? training : validation).map(opponent => opponent[0]), rows }) + '\n', { flag: 'wx' });
}
