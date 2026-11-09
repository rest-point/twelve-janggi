import { FastPosition, MASKS, actionCode, decodeAction } from './pvs-aspiration-rules-v1.mjs';

// An independent strict-v2 searcher, informed by Stockfish's search architecture.
// No Stockfish code, chess evaluation weights, or native executable is loaded.
const VALUE = [0, 0, 500, 350, 140, 600];
const MATE = 100000, INF = 200000, STOP = Symbol('search budget');
const advance = (sq, side) => side === 0 ? sq % 4 : 3 - sq % 4;
const bits = mask => { let count = 0; for (; mask; mask &= mask - 1) count++; return count; };
const integer = (v, fallback, lo, hi) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : fallback;

/** Material, reserves, king safety/try, defended squares and mobility; no NNUE. */
export function evaluatePosition(p) {
  const attacks = [0, 0], occupied = [0, 0];
  for (let sq = 0; sq < 12; sq++) {
    const piece = p.board[sq];
    if (piece) { attacks[piece >> 3] |= MASKS[piece][sq]; occupied[piece >> 3] |= 1 << sq; }
  }
  let result = 0;
  for (let sq = 0; sq < 12; sq++) {
    const piece = p.board[sq];
    if (!piece) continue;
    const side = piece >> 3, kind = piece & 7, enemy = side ^ 1, a = advance(sq, side);
    let value = VALUE[kind];
    if (kind === 1) {
      const neighbors = MASKS[piece][sq];
      value += [0, 35, 140, 0][a];
      value += 16 * bits(neighbors & ~occupied[side] & ~attacks[enemy]);
      value -= 12 * bits(neighbors & attacks[enemy]);
    } else {
      value += (kind === 4 ? 22 : 8) * a;
      if ((sq >> 2) === 1) value += 12;
      if (attacks[side] & (1 << sq)) value += 14;
      if (attacks[enemy] & (1 << sq)) value -= VALUE[kind] *
        (attacks[side] & (1 << sq) ? 0.08 : p.turn === side ? 0.16 : 0.4);
    }
    result += side === 0 ? value : -value;
  }
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    for (let kind = 0; kind < 3; kind++) result += sign * p.hands[side * 3 + kind] * VALUE[kind + 2] * 0.9;
    result += sign * 7 * bits(attacks[side] & ~occupied[side]);
    if (attacks[side ^ 1] & (1 << p.kings[side])) result -= sign * 45;
  }
  return Math.round((p.turn === 0 ? result : -result) + 8);
}

/** Every table, history and repetition context belongs to this request only. */
export function think({ state, legalActions, budgetMs = 60000, config = {} }) {
  const started = performance.now();
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const maxDepth = integer(config.maxDepth, 32, 1, 64);
  const maxNodes = integer(config.maxNodes, 160000, 1, 500000);
  const qDepth = integer(config.quiescenceDepth, 5, 0, 10);
  const tableSize = integer(config.tableEntries, 8192, 0, 16384);
  const window = integer(config.aspirationWindow, 60, 1, INF);
  const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 60000;
  const reserve = Math.max(10, Math.min(1000, budget * 0.05));
  const deadline = started + Math.max(0, Math.min(integer(config.maxTimeMs, 1000, 0, 55000), budget - reserve));
  const p = new FastPosition(state);
  const tt = new Map(), ordering = new Map(), ids = new Map(), path = new Map();
  const history = [new Int32Array(180), new Int32Array(180)], killers = [];
  let nodes = 0, completedDepth = 0, chosen = actionCode(legalActions[0]), previous = 0;

  function visit() {
    if (nodes >= maxNodes || performance.now() >= deadline) throw STOP;
    nodes++;
  }
  function put(table, key, value) {
    if (!tableSize) return;
    if (!table.has(key) && table.size >= tableSize) table.delete(table.keys().next().value);
    table.set(key, value);
  }
  function id(key) {
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  }
  function contextKey(boardKey) {
    // Root history is immutable. The exact multiset ADDED along this search
    // path distinguishes every repetition context; IDs are collision-free.
    // Board-only information below is used exclusively for MOVE ORDERING.
    const entries = [...path].map(([key, count]) => [id(key), count]).sort((a, b) => a[0] - b[0]);
    return `${id(boardKey)}|${entries.map(([key, count]) => `${key}:${count}`).join(',')}`;
  }
  function withMove(move, callback) {
    const undo = p.make(move), key = p.key();
    path.set(key, (path.get(key) || 0) + 1);
    try { return callback(); }
    finally {
      const count = path.get(key);
      if (count === 1) path.delete(key); else path.set(key, count - 1);
      p.unmake(undo);
    }
  }
  function terminal(winner, ply) { return winner === 'draw' ? 0 : winner === p.turn ? MATE - ply : -MATE + ply; }
  const storeScore = (score, ply) => score > MATE / 2 ? score + ply : score < -MATE / 2 ? score - ply : score;
  const loadScore = (score, ply) => score > MATE / 2 ? score - ply : score < -MATE / 2 ? score + ply : score;
  function properties(move) {
    const from = Math.floor(move / 12), to = move % 12;
    const piece = from < 12 ? p.board[from] : (from - 10) | (p.turn << 3);
    const kind = piece & 7, promoted = from < 12 && kind === 4 && advance(to, p.turn) === 3;
    const tryMove = kind === 1 && advance(to, p.turn) === 3;
    const check = !!(MASKS[promoted ? (5 | (p.turn << 3)) : piece][to] & (1 << p.kings[p.turn ^ 1]));
    return { victim: p.board[to] & 7, kind, promoted, tryMove, check };
  }
  function ordered(actions, ply, preferred) {
    return actions.map((move, index) => {
      const t = properties(move);
      let rank = history[p.turn][move];
      if (move === preferred) rank += 2000000;
      if (t.tryMove) rank += 1000000;
      if (t.victim) rank += 100000 + 16 * (VALUE[t.victim] + VALUE[t.victim === 5 ? 4 : t.victim] * 0.9) - VALUE[t.kind];
      if (t.promoted) rank += 80000;
      if (t.check) rank += 60000;
      if (killers[ply]?.includes(move)) rank += 40000;
      return { move, rank, index };
    }).sort((a, b) => b.rank - a.rank || a.index - b.index).map(item => item.move);
  }
  function quiescence(alpha, beta, remaining, ply, suppliedActions) {
    const actions = suppliedActions || p.actions(), winner = p.winner(actions);
    if (winner !== null) return terminal(winner, ply);
    const stand = evaluatePosition(p);
    if (!remaining) return stand;
    // Quiet defenses of an imminent try must be searched like check evasions.
    const forced = p.inCheck() || advance(p.kings[p.turn ^ 1], p.turn ^ 1) === 2;
    let best = forced ? -INF : stand;
    if (!forced) { if (stand >= beta) return stand; alpha = Math.max(alpha, stand); }
    const candidates = forced ? actions : actions.filter(move => {
      const t = properties(move); return t.victim || t.promoted || t.tryMove || t.check;
    });
    for (const move of ordered(candidates, ply)) {
      const score = withMove(move, () => { visit(); return -quiescence(-beta, -alpha, remaining - 1, ply + 1); });
      best = Math.max(best, score); alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return best;
  }
  function search(depth, alpha, beta, ply) {
    visit();
    if (depth <= 0) return quiescence(alpha, beta, qDepth, ply);
    const actions = p.actions(), winner = p.winner(actions);
    if (winner !== null) return terminal(winner, ply);
    // Mate distance pruning is valid because no static score approaches MATE.
    alpha = Math.max(alpha, -MATE + ply); beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;
    const originalAlpha = alpha, boardKey = p.key(), key = tableSize ? contextKey(boardKey) : null;
    const cached = tt.get(key);
    if (cached && cached.depth >= depth) {
      const score = loadScore(cached.score, ply);
      if (cached.flag === 0 || cached.flag === 1 && score >= beta || cached.flag === 2 && score <= alpha) return score;
    }
    let best = -INF, bestMove, first = true;
    for (const move of ordered(actions, ply, cached?.move ?? ordering.get(boardKey))) {
      const quiet = !p.board[move % 12];
      const score = withMove(move, () => {
        if (first) return -search(depth - 1, -beta, -alpha, ply + 1);
        let result = -search(depth - 1, -alpha - 1, -alpha, ply + 1);
        if (result > alpha && result < beta) result = -search(depth - 1, -beta, -alpha, ply + 1);
        return result;
      });
      first = false;
      if (score > best) { best = score; bestMove = move; }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) {
        if (quiet) {
          killers[ply] = [move, ...(killers[ply] || []).filter(m => m !== move)].slice(0, 2);
          // Bounded history gravity keeps old cutoffs from saturating the table.
          const bonus = Math.min(1600, depth * depth * 16), old = history[p.turn][move];
          history[p.turn][move] = old + bonus - Math.trunc(old * bonus / 32768);
        }
        break;
      }
    }
    put(ordering, boardKey, bestMove);
    put(tt, key, { depth, score: storeScore(best, ply), move: bestMove, flag: best <= originalAlpha ? 2 : best >= beta ? 1 : 0 });
    return best;
  }
  let rootActions = ordered(legalActions.map(actionCode), 0);
  chosen = rootActions[0];
  function rootSearch(depth, alpha, beta) {
    let best = -INF, bestMove = chosen;
    for (let i = 0; i < rootActions.length; i++) {
      const move = rootActions[i];
      const score = withMove(move, () => {
        if (i === 0) return -search(depth - 1, -beta, -alpha, 1);
        let result = -search(depth - 1, -alpha - 1, -alpha, 1);
        if (result > alpha && result < beta) result = -search(depth - 1, -beta, -alpha, 1);
        return result;
      });
      if (score > best) { best = score; bestMove = move; }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return { score: best, move: bestMove };
  }
  try {
    // Prefer an immediate proven try/mate over any heuristic material gain.
    for (const move of rootActions) {
      const winner = withMove(move, () => { visit(); return p.winner(); });
      if (winner === state.turn) return { action: decodeAction(move), info: { nodes, completedDepth: 1, searchMs: performance.now() - started } };
    }
    for (let depth = 1; depth <= maxDepth; depth++) {
      let delta = depth >= 3 ? window : INF;
      let alpha = Math.max(-INF, previous - delta), beta = Math.min(INF, previous + delta), result;
      for (;;) {
        result = rootSearch(depth, alpha, beta);
        if (result.score > alpha && result.score < beta) break;
        delta = Math.min(INF * 2, delta * 2);
        if (result.score <= alpha) alpha = Math.max(-INF, result.score - delta);
        if (result.score >= beta) beta = Math.min(INF, result.score + delta);
      }
      chosen = result.move; previous = result.score; completedDepth = depth;
      rootActions = [chosen, ...rootActions.filter(m => m !== chosen)];
      if (Math.abs(previous) >= MATE - depth - qDepth - 1) break;
    }
  } catch (error) { if (error !== STOP) throw error; }
  return { action: decodeAction(chosen), info: { nodes, completedDepth, searchMs: performance.now() - started } };
}
