// Policy-ordered alpha-beta with the unchanged v2 value network at the leaves.
// Rule transitions/terminal checks come from the existing validated compact core.
import { readFileSync } from 'node:fs';
import { fromEngine, historyFromEngine, fromEngineAction, toEngineAction, legal, step, verdict, features, canonAction, forward } from './azero-core.mjs';
const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
export const MATE = 1_000_000, SCALE = 10000;
const STOP = Symbol('limit'), INF = 2_000_000;
const integer = (n, fallback, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
export function neuralEvaluation(s, count = 1) {
  return Math.round(Math.tanh(forward(weights, features(s, count), [], new Float64Array(0))) * SCALE);
}

export function analyze({ state, legalActions, budgetMs = 60000, config = {} }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No live legal actions');
  const started = performance.now(), root = fromEngine(state), seen = historyFromEngine(state);
  const maxDepth = integer(config.maxDepth, 10, 1, 20), maxNodes = integer(config.maxNodes, 16000, 1, 100000);
  const cacheLimit = integer(config.cacheEntries, 3000, 0, 10000);
  const drawBias = Number.isFinite(config.drawBias) ? Math.max(0, Math.min(0.9, config.drawBias)) : 0;
  const deadline = started + Math.max(0, Math.min(integer(config.maxTimeMs, 2000, 0, 55000), budgetMs - Math.max(10, Math.min(1000, budgetMs * 0.05))));
  const cache = new Map(), preferred = new Map();
  let nodes = 0, completedDepth = 0, score = 0;
  const rootActions = legalActions.map(fromEngineAction);
  let chosen = rootActions[0];
  function limit(force = false) {
    if (nodes >= maxNodes || ((force || (nodes & 15) === 0) && performance.now() >= deadline)) throw STOP;
  }
  function terminal(s, aa, ply) {
    const result = verdict(s, aa, seen.get(s.key) || 1, Infinity);
    return result === null ? null : result === 0 ? (s.t === root.t ? -drawBias : drawBias) * SCALE : result * (MATE - ply);
  }
  function network(s, aa) {
    const count = seen.get(s.key) || 1, key = `${s.key}:${count}`;
    if (cache.has(key)) return cache.get(key);
    const logits = new Float64Array(aa.length), raw = forward(weights, features(s, count), aa.map(a => canonAction(a, s.t)), logits);
    const item = { value: Math.round(Math.tanh(raw) * SCALE), ordered: aa.map((a, i) => ({ a, value: logits[i], i }))
      .sort((a, b) => b.value - a.value || a.i - b.i).map(x => x.a) };
    if (cacheLimit) {
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, item);
    }
    return item;
  }
  function order(s, nn, best = preferred.get(s.key)) {
    return best === undefined ? nn.ordered : [best, ...nn.ordered.filter(a => a !== best)];
  }
  function child(s, a, work) {
    limit(); const next = step(s, a); nodes++;
    const old = seen.get(next.key) || 0; seen.set(next.key, old + 1);
    try { return work(next); } finally { if (old) seen.set(next.key, old); else seen.delete(next.key); }
  }
  function visit(s, depth, alpha, beta, ply) {
    limit(); const aa = legal(s), term = terminal(s, aa, ply);
    if (term !== null) return term;
    const nn = network(s, aa);
    if (depth === 0) return nn.value;
    let best = -INF, move;
    for (const a of order(s, nn)) {
      const value = child(s, a, next => -visit(next, depth - 1, -beta, -alpha, ply + 1));
      if (value > best) { best = value; move = a; }
      alpha = Math.max(alpha, value); if (alpha >= beta) break;
    }
    if (preferred.size >= 5000) preferred.delete(preferred.keys().next().value);
    preferred.set(s.key, move);
    return best;
  }
  try {
    limit(true);
    const nn = network(root, rootActions); chosen = nn.ordered[0]; score = nn.value;
    for (const a of rootActions) if (child(root, a, next => terminal(next, legal(next), 1)) === -(MATE - 1))
      return { action: toEngineAction(a), score: MATE - 1, info: { nodes, completedDepth: 1, searchMs: performance.now() - started } };
    for (let depth = 1; depth <= maxDepth; depth++) {
      limit(true); let best = -INF, action = chosen, alpha = -INF;
      for (const a of order(root, nn, chosen)) {
        const value = child(root, a, next => -visit(next, depth - 1, -INF, -alpha, 1));
        if (value > best) { best = value; action = a; }
        alpha = Math.max(alpha, value);
      }
      chosen = action; score = best; completedDepth = depth;
      if (best >= MATE - depth - 1) break;
    }
  } catch (error) { if (error !== STOP) throw error; }
  return { action: toEngineAction(chosen), score: score === 0 ? 0 : score, info: { nodes, completedDepth, searchMs: performance.now() - started } };
}
export function think(request) { const { action, info } = analyze(request); return { action, info }; }
