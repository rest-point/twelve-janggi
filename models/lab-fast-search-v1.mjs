// Classical alpha-beta on the existing, validated compact rules representation.
// Unlike the original AlphaZero entry, live human positions past ply 256 remain
// playable: the referee owns batch limits; this search only uses rule terminals.
import { directions } from '../src/engine.js';
import { fromEngine, historyFromEngine, fromEngineAction, toEngineAction, legal, step, verdict } from './azero-core.mjs';

export const MATE = 1_000_000;
const INF = 2_000_000, STOP = Symbol('limit');
const KINDS = [null, 'king', 'rook', 'bishop', 'pawn', 'hen'];
const VALUES = [0, 0, 500, 350, 140, 600];
const MASK = Array.from({ length: 11 }, (_, code) => Array.from({ length: 12 }, (_, square) => {
  if (!code) return 0;
  const side = code > 5 ? 1 : 0, kind = code - side * 5;
  return directions(KINDS[kind], side).reduce((mask, [dx, dy]) => {
    const x = square % 4 + dx, y = (square >> 2) + dy;
    return x >= 0 && x < 4 && y >= 0 && y < 3 ? mask | (1 << (y * 4 + x)) : mask;
  }, 0);
}));
const advance = (sq, side) => side === 0 ? sq % 4 : 3 - sq % 4;
const bits = mask => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
const integer = (n, fallback, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
function geometry(s) {
  const attacks = [0, 0], occupied = [0, 0], kings = [-1, -1];
  for (let sq = 0; sq < 12; sq++) {
    const c = s.b[sq]; if (!c) continue;
    const side = c > 5 ? 1 : 0;
    attacks[side] |= MASK[c][sq]; occupied[side] |= 1 << sq;
    if (c - side * 5 === 1) kings[side] = sq;
  }
  return { attacks, occupied, kings };
}
export function evaluatePosition(s) {
  const { attacks, occupied, kings } = geometry(s);
  let score = 0;
  for (let sq = 0; sq < 12; sq++) {
    const c = s.b[sq]; if (!c) continue;
    const side = c > 5 ? 1 : 0, kind = c - side * 5, enemy = 1 - side, a = advance(sq, side);
    let v = VALUES[kind];
    if (kind === 1) {
      v += [0, 35, 140, 0][a];
      v += 16 * bits(MASK[c][sq] & ~occupied[side] & ~attacks[enemy]);
      v -= 12 * bits(MASK[c][sq] & attacks[enemy]);
    } else {
      v += (kind === 4 ? 22 : 8) * a;
      if ((sq >> 2) === 1) v += 12;
      if (attacks[side] & (1 << sq)) v += 14;
      if (attacks[enemy] & (1 << sq)) v -= VALUES[kind] * (attacks[side] & (1 << sq) ? 0.08 : s.t === side ? 0.16 : 0.4);
    }
    score += side === 0 ? v : -v;
  }
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) score += sign * VALUES[k + 2] * s.h[side * 3 + k] * 0.9;
    score += sign * 7 * bits(attacks[side] & ~occupied[side]);
    if (attacks[1 - side] & (1 << kings[side])) score -= sign * 45;
  }
  return Math.round((s.t === 0 ? score : -score) + 8);
}

export function analyze({ state, legalActions, budgetMs = 60000, config = {} }) {
  const started = performance.now();
  if (state.winner !== null || !legalActions?.length) throw new Error('No live legal actions');
  const root = fromEngine(state), seen = historyFromEngine(state), pathCounts = new Map();
  const maxDepth = integer(config.maxDepth, 24, 1, 40), maxNodes = integer(config.maxNodes, 500000, 1, 4000000);
  const qDepth = integer(config.quiescenceDepth, 4, 0, 8), tableSize = integer(config.tableEntries, 16384, 0, 65536);
  const deadline = started + Math.max(0, Math.min(integer(config.maxTimeMs, 1500, 0, 55000), budgetMs - Math.max(10, Math.min(1000, budgetMs * 0.05))));
  const table = new Map(), moves = new Map();
  let nodes = 0, completedDepth = 0, score = evaluatePosition(root);
  let actions = legalActions.map(fromEngineAction), chosen = actions[0];
  function limit(force = false) {
    if (nodes >= maxNodes || ((force || (nodes & 63) === 0) && performance.now() >= deadline)) throw STOP;
  }
  function remember(map, key, value) {
    if (!tableSize) return;
    if (!map.has(key) && map.size >= tableSize) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  function terminal(s, aa, ply) {
    const result = verdict(s, aa, seen.get(s.key) || 1, Infinity);
    return result === null ? null : result === 0 ? 0 : result * (MATE - ply);
  }
  function child(s, a, work) {
    limit(); const next = step(s, a); nodes++;
    const previous = seen.get(next.key) || 0, added = pathCounts.get(next.key) || 0;
    seen.set(next.key, previous + 1); pathCounts.set(next.key, added + 1);
    try { return work(next); }
    finally {
      if (previous) seen.set(next.key, previous); else seen.delete(next.key);
      if (added) pathCounts.set(next.key, added); else pathCounts.delete(next.key);
    }
  }
  function context(s, depth) {
    return `${depth}|${s.key}|${s.ply}|${[...pathCounts].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(',')}`;
  }
  function details(s, a, enemyKing) {
    const drop = a >= 144, to = drop ? (a - 144) % 12 : a % 12, from = drop ? -1 : (a / 12 | 0);
    const kind = drop ? ((a - 144) / 12 | 0) + 2 : s.b[from] - s.t * 5;
    const promoted = kind === 4 && !drop && advance(to, s.t) === 3;
    const check = !!(MASK[s.t * 5 + (promoted ? 5 : kind)][to] & (1 << enemyKing));
    const capture = s.b[to] ? s.b[to] - (s.b[to] > 5 ? 5 : 0) : 0;
    const entry = kind === 1 && advance(to, s.t) === 3;
    return { tactical: !!capture || promoted || check || entry,
      priority: (entry ? MATE : 0) + (capture ? 100000 + 16 * VALUES[capture] - VALUES[kind] : 0) + (promoted ? 80000 : 0) + (check ? 60000 : 0) };
  }
  function ordered(s, aa, preferred) {
    const king = s.b.indexOf((1 - s.t) * 5 + 1);
    return aa.map((a, i) => ({ a, i, n: a === preferred ? INF : details(s, a, king).priority }))
      .sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.a);
  }
  function quiet(s, aa, alpha, beta, remaining, ply) {
    const stand = evaluatePosition(s);
    if (remaining <= 0) return stand;
    const g = geometry(s), king = g.kings[1 - s.t];
    const forced = !!(g.attacks[1 - s.t] & (1 << g.kings[s.t])) || advance(king, 1 - s.t) === 2;
    let best = forced ? -INF : stand;
    if (!forced) { if (stand >= beta) return stand; alpha = Math.max(alpha, stand); }
    for (const a of ordered(s, aa.filter(a => forced || details(s, a, king).tactical), moves.get(s.key))) {
      const value = child(s, a, next => {
        const nextActions = legal(next), term = terminal(next, nextActions, ply + 1);
        return -(term === null ? quiet(next, nextActions, -beta, -alpha, remaining - 1, ply + 1) : term);
      });
      best = Math.max(best, value); alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return best;
  }
  function visit(s, depth, alpha, beta, ply) {
    limit(); const aa = legal(s), term = terminal(s, aa, ply);
    if (term !== null) return term;
    if (depth === 0) return quiet(s, aa, alpha, beta, qDepth, ply);
    const key = tableSize ? context(s, depth) : null, cached = table.get(key), originalAlpha = alpha;
    if (cached && (cached.flag === 'exact' || cached.flag === 'lower' && cached.value >= beta || cached.flag === 'upper' && cached.value <= alpha)) return cached.value;
    let best = -INF, move;
    for (const a of ordered(s, aa, cached?.move ?? moves.get(s.key))) {
      const value = child(s, a, next => -visit(next, depth - 1, -beta, -alpha, ply + 1));
      if (value > best) { best = value; move = a; }
      alpha = Math.max(alpha, value); if (alpha >= beta) break;
    }
    remember(moves, s.key, move);
    remember(table, key, { value: best, move, flag: best <= originalAlpha ? 'upper' : best >= beta ? 'lower' : 'exact' });
    return best;
  }
  try {
    actions = ordered(root, actions);
    chosen = actions[0];
    for (const a of actions) if (child(root, a, next => terminal(next, legal(next), 1)) === -(MATE - 1))
      return { action: toEngineAction(a), score: MATE - 1, info: { nodes, completedDepth: 1, searchMs: performance.now() - started } };
    for (let depth = 1; depth <= maxDepth; depth++) {
      limit(true);
      let alpha = -INF, best = -INF, action = chosen;
      for (const a of ordered(root, actions, chosen)) {
        const value = child(root, a, next => -visit(next, depth - 1, -INF, -alpha, 1));
        if (value > best) { best = value; action = a; }
        alpha = Math.max(alpha, value);
      }
      chosen = action; score = best; completedDepth = depth;
      if (best >= MATE - depth - qDepth - 1) break;
    }
  } catch (error) { if (error !== STOP) throw error; }
  return { action: toEngineAction(chosen), score: score === 0 ? 0 : score, info: { nodes, completedDepth, searchMs: performance.now() - started } };
}
export function think(request) { const { action, info } = analyze(request); return { action, info }; }
