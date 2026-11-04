import { applyAction, directions, isInCheck, legalActions as generateActions } from '../src/engine.js';

// Independent, classical search model. All actual moves and terminal decisions
// go through the project's referee engine; attack masks below are heuristics.
const VALUE = { king: 0, rook: 500, bishop: 350, pawn: 140, hen: 600 };
const DROP = { rook: 12, bishop: 13, pawn: 14 };
const MATE = 100000;
const INF = 200000;
const STOP = Symbol('search limit');
const MASKS = [0, 1].map(side => Object.fromEntries(Object.keys(VALUE).map(kind => [kind,
  Array.from({ length: 12 }, (_, from) => directions(kind, side).reduce((mask, [dx, dy]) => {
    const x = from % 4 + dx, y = Math.floor(from / 4) + dy;
    return x >= 0 && x < 4 && y >= 0 && y < 3 ? mask | (1 << (y * 4 + x)) : mask;
  }, 0)),
])));
const code = a => (a.drop ? DROP[a.drop] : a.from) * 12 + a.to;
const advance = (square, side) => side === 0 ? square % 4 : 3 - square % 4;
const popcount = mask => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
const integer = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

function attacks(state) {
  const masks = [0, 0], kings = [-1, -1], occupied = [0, 0];
  state.board.forEach((piece, square) => {
    if (!piece) return;
    masks[piece.side] |= MASKS[piece.side][piece.kind][square];
    occupied[piece.side] |= 1 << square;
    if (piece.kind === 'king') kings[piece.side] = square;
  });
  return { masks, kings, occupied };
}

function evaluate(state) {
  const { masks, kings, occupied } = attacks(state);
  let score = 0;
  state.board.forEach((piece, square) => {
    if (!piece) return;
    const { side, kind } = piece, enemy = 1 - side, a = advance(square, side);
    let value = VALUE[kind];
    if (kind === 'king') {
      const neighbors = MASKS[side].king[square];
      value += [0, 35, 140, 0][a];
      value += 16 * popcount(neighbors & ~occupied[side] & ~masks[enemy]);
      value -= 12 * popcount(neighbors & masks[enemy]);
    } else {
      value += (kind === 'pawn' ? 22 : 8) * a;
      if (Math.floor(square / 4) === 1) value += 12;
      if (masks[side] & (1 << square)) value += 14;
      if (masks[enemy] & (1 << square)) {
        const defended = !!(masks[side] & (1 << square));
        value -= VALUE[kind] * (defended ? 0.08 : state.turn === side ? 0.16 : 0.4);
      }
    }
    score += side === 0 ? value : -value;
  });
  for (const side of [0, 1]) {
    const sign = side === 0 ? 1 : -1;
    for (const kind of state.hands[side]) score += sign * VALUE[kind] * 0.9;
    score += sign * 7 * popcount(masks[side] & ~occupied[side]);
    if (masks[1 - side] & (1 << kings[side])) score -= sign * 45;
  }
  return Math.round((state.turn === 0 ? score : -score) + 8);
}

function promotedKind(state, action) {
  const kind = action.drop || state.board[action.from].kind;
  return !action.drop && kind === 'pawn' && advance(action.to, state.turn) === 3 ? 'hen' : kind;
}

function checking(state, action, enemyKing) {
  return !!(MASKS[state.turn][promotedKind(state, action)][action.to] & (1 << enemyKing));
}

function tactical(state, action, enemyKing) {
  return !!state.board[action.to]
    || (!action.drop && state.board[action.from].kind === 'pawn' && advance(action.to, state.turn) === 3)
    || (!action.drop && state.board[action.from].kind === 'king' && advance(action.to, state.turn) === 3)
    || checking(state, action, enemyKing);
}

/** js-v1. Every cache and heuristic is scoped to this request, including IDs. */
export function think({ state, legalActions, budgetMs = 60000, config = {} }) {
  const started = performance.now();
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const maxDepth = integer(config.maxDepth, 24, 1, 48);
  const maxNodes = integer(config.maxNodes, 40000, 1, 200000);
  const qDepth = integer(config.quiescenceDepth, 4, 0, 8);
  const tableSize = integer(config.tableEntries, 8192, 0, 16384);
  const timeMs = integer(config.maxTimeMs, 1500, 0, 55000);
  const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 60000;
  const reserve = Math.max(10, Math.min(1000, budget * 0.05));
  const deadline = started + Math.max(0, Math.min(timeMs, budget - reserve));
  // Logs have no bearing on rules; preserve the full repetition history.
  const root = { ...state, log: [] };
  const baseLength = state.positions.length;
  const tt = new Map(), moveTable = new Map(), positionIds = new Map();
  const history = [new Int32Array(180), new Int32Array(180)];
  const killers = [];
  let nodes = 0, completedDepth = 0, chosen;

  function checkLimit() {
    if (nodes >= maxNodes || performance.now() >= deadline) throw STOP;
  }
  function terminal(s, ply) {
    return s.winner === 'draw' ? 0 : s.winner === s.turn ? MATE - ply : -MATE + ply;
  }
  function put(table, key, value) {
    if (!tableSize) return;
    if (!table.has(key) && table.size >= tableSize) table.delete(table.keys().next().value);
    table.set(key, value);
  }
  function id(key) {
    if (!positionIds.has(key)) positionIds.set(key, positionIds.size);
    return positionIds.get(key);
  }
  function contextKey(s) {
    // The base history is immutable and shared by every node in this request.
    // Encode the EXACT multiset added along the search path, with collision-free
    // interned position IDs. Equal boards with different counts cannot share a
    // score. Order does not affect strict-v2 threefold adjudication.
    const counts = new Map();
    for (let i = baseLength; i < s.positions.length; i++) {
      const key = id(s.positions[i]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return `${id(s.positions.at(-1))}|${[...counts].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(',')}`;
  }
  function ordered(s, actions, ply, preferred) {
    const enemyKing = s.board.findIndex(p => p?.side === 1 - s.turn && p.kind === 'king');
    return actions.map((a, index) => {
      const key = code(a), victim = s.board[a.to];
      const kind = a.drop || s.board[a.from].kind;
      let rank = history[s.turn][key];
      if (key === preferred) rank += 2000000;
      if (!a.drop && kind === 'king' && advance(a.to, s.turn) === 3) rank += 1000000;
      if (victim) rank += 100000 + 16 * (VALUE[victim.kind] + VALUE[victim.kind === 'hen' ? 'pawn' : victim.kind] * 0.9) - VALUE[kind];
      if (promotedKind(s, a) !== kind) rank += 80000;
      if (checking(s, a, enemyKing)) rank += 60000;
      if (killers[ply]?.includes(key)) rank += 40000;
      return { action: a, rank, index };
    }).sort((a, b) => b.rank - a.rank || a.index - b.index).map(item => item.action);
  }
  function child(s, action) {
    checkLimit();
    const next = applyAction(s, action, false);
    nodes++;
    return next;
  }

  function quiescence(s, alpha, beta, remaining, ply) {
    checkLimit();
    if (s.winner !== null) return terminal(s, ply);
    const stand = evaluate(s);
    if (remaining <= 0) return stand;
    const inCheck = isInCheck(s);
    const enemyKing = s.board.findIndex(p => p?.side === 1 - s.turn && p.kind === 'king');
    // A king one step from try can require a quiet defensive move. In this
    // case, as in check, do not assume that passing preserves the static score.
    const forced = inCheck || advance(enemyKing, 1 - s.turn) === 2;
    let best = forced ? -INF : stand;
    if (!forced) {
      if (stand >= beta) return stand;
      alpha = Math.max(alpha, stand);
    }
    const actions = generateActions(s).filter(a => forced || tactical(s, a, enemyKing));
    for (const a of ordered(s, actions, ply)) {
      const score = -quiescence(child(s, a), -beta, -alpha, remaining - 1, ply + 1);
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return best;
  }

  function search(s, depth, alpha, beta, ply) {
    checkLimit();
    if (s.winner !== null) return terminal(s, ply);
    if (depth <= 0) return quiescence(s, alpha, beta, qDepth, ply);
    const originalAlpha = alpha;
    const key = tableSize ? contextKey(s) : null;
    const cached = tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === 'exact') return cached.score;
      if (cached.flag === 'lower' && cached.score >= beta) return cached.score;
      if (cached.flag === 'upper' && cached.score <= alpha) return cached.score;
    }
    const boardKey = s.positions.at(-1);
    const actions = ordered(s, generateActions(s), ply, cached?.move ?? moveTable.get(boardKey));
    let best = -INF, bestMove, first = true;
    for (const a of actions) {
      const next = child(s, a);
      let score;
      if (first) score = -search(next, depth - 1, -beta, -alpha, ply + 1);
      else {
        // Principal variation search: scout later moves before a full window.
        score = -search(next, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) score = -search(next, depth - 1, -beta, -alpha, ply + 1);
      }
      first = false;
      if (score > best) { best = score; bestMove = code(a); }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) {
        if (!s.board[a.to]) {
          killers[ply] = [code(a), ...(killers[ply] || []).filter(k => k !== code(a))].slice(0, 2);
          history[s.turn][code(a)] = Math.min(30000, history[s.turn][code(a)] + depth * depth);
        }
        break;
      }
    }
    put(moveTable, boardKey, bestMove); // Board-only cache is move ordering ONLY.
    put(tt, key, { depth, score: best, move: bestMove, flag: best <= originalAlpha ? 'upper' : best >= beta ? 'lower' : 'exact' });
    return best;
  }

  let rootActions = ordered(root, [...legalActions], 0);
  chosen = rootActions[0];
  const rootChildren = new Map();
  try {
    // Complete this cheap scan before deep search, so any immediate mate/try
    // wins over a superficially attractive capture. It is also budgeted.
    for (const a of rootActions) {
      const next = child(root, a);
      rootChildren.set(code(a), next);
      if (next.winner === root.turn) {
        return { action: a, info: { nodes, completedDepth: 1, searchMs: performance.now() - started } };
      }
    }
    for (let depth = 1; depth <= maxDepth; depth++) {
      checkLimit();
      let alpha = -INF, best = -INF, bestAction = chosen;
      const scores = new Map();
      for (let i = 0; i < rootActions.length; i++) {
        const a = rootActions[i], next = rootChildren.get(code(a));
        let score = -search(next, depth - 1, -INF, -alpha, 1);
        scores.set(code(a), score);
        if (score > best) { best = score; bestAction = a; }
        alpha = Math.max(alpha, score);
      }
      // Publish only a fully searched iteration; interruption keeps this result.
      chosen = bestAction;
      completedDepth = depth;
      rootActions.sort((a, b) => scores.get(code(b)) - scores.get(code(a)));
      if (best >= MATE - depth - qDepth - 1) break;
    }
  } catch (error) {
    if (error !== STOP) throw error;
  }
  return { action: chosen, info: { nodes, completedDepth, searchMs: performance.now() - started } };
}
