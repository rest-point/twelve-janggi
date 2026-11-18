// League data generation for tbrl-* models.
// Plays the tablebase-safe policy (optionally guided by an MLP value network,
// with epsilon exploration) against registered league models using their
// registry configs, and records one row per decision point:
//   [features..., won, blunderNext, opponentIndex (+64 if the move was exploratory), plyFraction]
// Usage:
//   node train/tbrl-league.mjs --games 2000 --workers 14 --out data/r0.bin \
//     [--weights models/tbrl-v2.bin --hidden 128,64 [--trap]] [--eps 0.2] [--opponents a,b,c]
// Rows always hold the base features; trap features are added by tbrl-augment.mjs.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseArgs } from 'node:util';
import { applyAction, initialState, legalActions, isLegalAction } from '../src/engine.js';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { FEATURES, TRAP, openTable, classify, safeCandidates, createMlp, candidateInput, rng } from '../models/tbrl-core.mjs';

const ROOT = new URL('../', import.meta.url);
export const DEFAULT_OPPONENTS = ['packed-gemm-puct-v2', 'azero-v2', 'stockjang-v1', 'team-mcts-v1',
  'minimax-v1', 'greedy-v1', 'random-v1'];
const COLUMNS = FEATURES + 4;

async function loadModel(id) {
  const registry = JSON.parse(readFileSync(new URL('models/registry.json', ROOT)));
  const entry = registry.find(m => m.id === id);
  if (!entry) throw new Error(`Unknown model ${id}`);
  const module = await import(new URL(path.posix.join('models', entry.entry), ROOT));
  return { id, think: module.think, config: entry.config };
}

function makePolicy(options) {
  const table = openTable(2048);
  let mlp = null;
  if (options.weights) {
    const bytes = readFileSync(options.weights);
    mlp = createMlp(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), options.hidden, options.trap ? FEATURES + TRAP : FEATURES);
  }
  return (state, actions, random, explore) => {
    const children = classify(state, actions, table);
    const { tier, eligible } = safeCandidates(children);
    if (eligible.length === 1) return { child: eligible[0], decision: false, tier };
    let child, explored = false;
    if (explore && random() < options.eps) { child = eligible[Math.floor(random() * eligible.length)]; explored = true; }
    else if (mlp) {
      let best = -Infinity;
      for (const c of eligible) {
        const s = mlp(candidateInput(state, c, table, options.trap)) + 1e-6 * random();
        if (s > best) { best = s; child = c; }
      }
    } else child = eligible[Math.floor(random() * eligible.length)];
    return { child, decision: true, tier, explored };
  };
}

async function worker() {
  const { options, workerIndex } = workerData;
  const policy = makePolicy(options);
  const opponents = [];
  for (const id of options.opponents) opponents.push(await loadModel(id));
  const table = openTable(512);
  parentPort.on('message', async job => {
    if (job === null) { process.exit(0); }
    const random = rng(job.seed);
    const opponent = opponents[job.opponent];
    const us = job.us, first = job.first;
    let state = initialState(first);
    const rows = [], decisions = [];
    let failure = null, blunderPending = -1;
    const times = [];
    try {
      while (state.winner === null && state.ply < 256) {
        const actions = legalActions(state);
        if (state.turn === us) {
          const t = performance.now();
          const { child, decision, explored } = policy(state, actions, random, true);
          times.push(performance.now() - t);
          if (decision) { decisions.push({ features: Float32Array.from(child.features), ply: state.ply, value: child.value, explored }); blunderPending = decisions.length - 1; }
          else blunderPending = -1;
          state = applyAction(state, child.action, false);
        } else {
          const request = { protocol: 'js-v1', requestId: `${job.index}:${state.ply}`, ruleset: state.ruleset, state,
            legalActions: actions, budgetMs: 60000, seed: (job.seed ^ (state.ply * 2654435761)) >>> 0, config: opponent.config };
          const response = await opponent.think(request);
          if (!response?.action || !isLegalAction(state, response.action)) { failure = 'opponent-illegal'; break; }
          const before = blunderPending;
          state = applyAction(state, response.action, false);
          if (before >= 0) {
            // Did the opponent just step into a proven loss (or lose outright)?
            let lost = state.winner === us;
            if (state.winner === null) {
              const raw = table.probe(new FastPosition(state));
              lost = raw >= 256; // side to move (us) wins
            }
            decisions[before].blunder = lost ? 1 : 0;
          }
        }
      }
    } catch (error) { failure = `error:${error.message}`; }
    const winner = state.winner === null ? 'draw' : state.winner;
    const won = winner === us ? 1 : 0;
    const out = new Float32Array(decisions.length * COLUMNS);
    decisions.forEach((d, i) => {
      out.set(d.features, i * COLUMNS);
      out[i * COLUMNS + FEATURES] = won;
      out[i * COLUMNS + FEATURES + 1] = d.blunder ?? 0;
      out[i * COLUMNS + FEATURES + 2] = job.opponent + (d.explored ? 64 : 0);
      out[i * COLUMNS + FEATURES + 3] = d.ply / 256;
    });
    parentPort.postMessage({ index: job.index, opponent: job.opponent, us, first, winner, plies: state.ply, failure,
      termination: state.termination, rows: failure ? null : out, maxMs: Math.max(0, ...times),
      meanMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length) }, failure ? [] : [out.buffer]);
  });
  parentPort.postMessage({ ready: workerIndex });
}

async function main() {
  const { values } = parseArgs({ options: {
    games: { type: 'string', default: '200' }, workers: { type: 'string', default: '14' }, out: { type: 'string' },
    weights: { type: 'string' }, hidden: { type: 'string', default: '128,64' }, eps: { type: 'string', default: '0.15' }, trap: { type: 'boolean', default: false }, as: { type: 'string', default: 'any' },
    opponents: { type: 'string' }, mix: { type: 'string' }, seed: { type: 'string', default: '1' }, log: { type: 'string' },
  } });
  if (!values.out) throw new Error('--out is required');
  const options = { weights: values.weights ? path.resolve(values.weights) : null, hidden: values.hidden.split(',').map(Number),
    eps: Number(values.eps), trap: values.trap, opponents: values.opponents ? values.opponents.split(',') : DEFAULT_OPPONENTS };
  const mix = values.mix ? values.mix.split(',').map(Number) : options.opponents.map(() => 1);
  const games = Number(values.games), seed = Number(values.seed);
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  writeFileSync(values.out, Buffer.alloc(0));
  const jobs = [];
  const random = rng(seed * 7919 + 13), total = mix.reduce((a, b) => a + b, 0);
  for (let i = 0; i < games; i++) {
    let r = random() * total, opponent = 0;
    while (r >= mix[opponent]) r -= mix[opponent++];
    const us = i % 2, first = values.as === 'second' ? 1 - us : values.as === 'first' ? us : (i >> 1) % 2;
    jobs.push({ index: i, opponent, us, first, seed: (seed * 1000003 + i * 7477) >>> 0 });
  }
  const stats = options.opponents.map(id => ({ id, games: 0, wins: 0, draws: 0, losses: 0, failures: 0, asFirst: [0, 0], maxMs: 0, meanMs: 0 }));
  let next = 0, done = 0, rows = 0;
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const count = Math.min(Number(values.workers), games);
    let live = count;
    for (let w = 0; w < count; w++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { options, workerIndex: w } });
      const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
      worker.on('message', message => {
        if (message.ready !== undefined) return feed();
        const s = stats[message.opponent];
        s.games++;
        if (message.failure) s.failures++;
        else if (message.winner === 'draw') s.draws++;
        else if (message.winner === message.us) { s.wins++; if (message.first === message.us) s.asFirst[0]++; else s.asFirst[1]++; }
        else s.losses++;
        s.maxMs = Math.max(s.maxMs, message.maxMs);
        s.meanMs += (message.meanMs - s.meanMs) / s.games;
        if (message.rows) { appendFileSync(values.out, Buffer.from(message.rows.buffer)); rows += message.rows.length / COLUMNS; }
        if (values.log) appendFileSync(values.log, JSON.stringify({ ...message, rows: undefined }) + '\n');
        done++;
        if (done % 50 === 0 || done === games) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`${done}/${games} games, ${rows} rows, ${rate.toFixed(2)} games/s :: ` +
            stats.filter(x => x.games).map(x => `${x.id} ${x.wins}/${x.draws}/${x.losses}${x.failures ? ` f${x.failures}` : ''}`).join(' | '));
        }
        feed();
      });
      worker.on('error', reject);
      worker.on('exit', () => { if (--live === 0) resolve(); });
    }
  });
  const summary = { games, rows, columns: COLUMNS, features: FEATURES, opponents: stats, seconds: (Date.now() - started) / 1000 };
  writeFileSync(values.out + '.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(stats.map(s => ({ id: s.id, w: s.wins, d: s.draws, l: s.losses, f: s.failures, firstWins: s.asFirst[0], secondWins: s.asFirst[1], meanMs: +s.meanMs.toFixed(2), maxMs: +s.maxMs.toFixed(1) }))));
}

if (isMainThread) await main(); else await worker();
