// node train/arena.mjs --ckpt file.bin --opp normal,hard,ab6,ab8 --games 100 --sims 400 --workers 2 --opening 4
// Referee is the real src/engine.js. Games alternate color; openings are random legal plies.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initialState, legalActions, applyAction, chooseAI } from '../src/engine.js';
import { fromEngine, historyFromEngine, toEngineAction, search, legal, step, verdict } from '../models/azero-core.mjs';

const VALUE = [0, 15000, 30, 25, 10, 45], HAND = [30, 25, 10];
function evaluate(s) {
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const c = s.b[i];
    if (!c) continue;
    const side = c > 5 ? 1 : 0, kind = c - side * 5, advance = side === 0 ? i % 4 : 3 - i % 4;
    n += (side === s.t ? 1 : -1) * (VALUE[kind] + advance * (kind === 1 ? 8 : 2));
  }
  for (let side = 0; side < 2; side++) for (let k = 0; k < 3; k++) n += (side === s.t ? 1 : -1) * s.h[side * 3 + k] * HAND[k] * 0.8;
  return n;
}
// Same evaluation as chooseAI, much deeper: iterative deepening alpha-beta with a transposition table.
// ponytail: TT ignores repetition history (graph-history problem); a stronger baseline would key on path.
function alphaBeta(state, depth) {
  const root = fromEngine(state), seen = historyFromEngine(state), tt = new Map();
  let best = null;
  const visit = (s, d, alpha, beta, ply) => {
    const acts = legal(s), term = verdict(s, acts, seen.get(s.key) || 1);
    if (term !== null) return term * (100000 - ply);
    if (d === 0) return evaluate(s);
    const hit = tt.get(s.key);
    if (hit && hit.d >= d && ply > 0 && hit.exact) return hit.v;
    const score = a => (hit && hit.a === a ? 1e6 : 0) + (a < 144 && s.b[a % 12] ? VALUE[s.b[a % 12] > 5 ? s.b[a % 12] - 5 : s.b[a % 12]] : 0);
    acts.sort((x, y) => score(y) - score(x));
    let top = -Infinity, pick = acts[0];
    const from = alpha;
    for (const a of acts) {
      const n = step(s, a);
      seen.set(n.key, (seen.get(n.key) || 0) + 1);
      const v = -visit(n, d - 1, -beta, -alpha, ply + 1);
      seen.set(n.key, seen.get(n.key) - 1);
      if (v > top) { top = v; pick = a; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    tt.set(s.key, { d, v: top, a: pick, exact: top > from && top < beta });
    if (ply === 0) best = pick;
    return top;
  };
  for (let d = 1; d <= depth; d++) visit(root, d, -Infinity, Infinity, 0);
  return toEngineAction(best);
}
function opponent(name) {
  if (name.startsWith('net:')) return loadPlayer(name.slice(4), workerData.sims);
  if (name === 'greedy') return s => chooseAI(s, 'easy');
  if (name === 'normal' || name === 'hard') return s => chooseAI(s, name);
  const depth = Number(name.slice(2));
  return s => alphaBeta(s, depth);
}
function loadPlayer(path, sims) {
  const w = new Float32Array(readFileSync(path).buffer.slice(0));
  return state => {
    const root = search(fromEngine(state), historyFromEngine(state), w, { sims });
    return toEngineAction(root.acts[root.N.indexOf(Math.max(...root.N))]);
  };
}
function playOne(index, me, other, opening) {
  let state = initialState();
  const mine = index % 2;
  for (let i = 0; i < opening; i++) {
    const acts = legalActions(state), next = applyAction(state, acts[Math.floor(Math.random() * acts.length)], false);
    if (next.winner !== null) break;
    state = next;
  }
  const started = state.ply;
  while (state.winner === null && state.ply - started < 256) state = applyAction(state, (state.turn === mine ? me : other)(state), false);
  const r = state.winner === null || state.winner === 'draw' ? 'D' : state.winner === mine ? 'W' : 'L';
  return { r, plies: state.ply, why: state.termination || 'max-plies', mine };
}

if (!isMainThread) {
  const { ckpt, sims, opp, opening } = workerData, me = loadPlayer(ckpt, sims), other = opponent(opp);
  parentPort.on('message', index => parentPort.postMessage(playOne(index, me, other, opening)));
} else {
  const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(x => x.trim().split(' ')));
  const games = Number(args.games || 100), sims = Number(args.sims || 400), count = Number(args.workers || 2), opening = Number(args.opening ?? 4);
  for (const opp of (args.opp || 'normal').split(',')) {
    const tally = { W: 0, D: 0, L: 0 }, why = {}, started = Date.now();
    let next = 0, done = 0, plies = 0;
    await new Promise((resolve, reject) => {
      for (let i = 0; i < count; i++) {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { ckpt: args.ckpt, sims, opp, opening } });
        worker.on('error', reject);
        worker.on('message', x => {
          tally[x.r]++; plies += x.plies; why[x.why] = (why[x.why] || 0) + 1;
          if (++done === games) { worker.terminate(); resolve(); } else if (next < games) worker.postMessage(next++); else worker.terminate();
        });
        worker.postMessage(next++);
      }
    });
    console.log(`${opp}: W${tally.W} D${tally.D} L${tally.L} score ${((tally.W + tally.D / 2) / games * 100).toFixed(1)}% avgPlies ${(plies / games).toFixed(0)} ${(Date.now() - started) / 1000 | 0}s ${JSON.stringify(why)}`);
  }
  process.exit(0);
}
