import { performance } from 'node:perf_hooks';
import { FastPosition, MASKS, actionCode, decodeAction } from './pvs-aspiration-rules-v1.mjs';

const MATE = 100000, INF = 200000, STOP = Symbol('search budget');
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const integer = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

/** Interpret one full-material oracle result without discarding repetition history. */
export function classifyTablebase(position, tablebase) {
  const actions = position.actions();
  const winner = position.winner(actions);
  if (winner !== null) {
    const outcome = winner === 'draw' ? 0 : winner === position.turn ? 1 : -1;
    return { outcome, distance: 0, score: outcome * MATE, certain: true, terminal: true };
  }

  const raw = tablebase.probe(position);
  if (raw === 1) return { outcome: 0, distance: null, score: 0, certain: true, terminal: false };
  if (!Number.isSafeInteger(raw) || Math.abs(raw) < 256) return null;

  const outcome = Math.sign(raw), distance = Math.abs(raw) - 256;
  let certain = true;
  for (const [key, count] of position.counts) {
    if (count < 2) continue;
    const previous = tablebase.probeKey(key);
    if (Number.isSafeInteger(previous) && previous !== 0) {
      certain = false;
      break;
    }
  }
  return { outcome, distance, score: outcome * (MATE - distance), certain, terminal: false };
}

/** Search one request with injected oracle, neural and proof services. */
export function analyze(request, services = {}) {
  const { state, legalActions, config = {} } = request || {};
  if (!state || state.winner !== null || !Array.isArray(legalActions) || !legalActions.length) {
    throw new Error('No live legal actions');
  }
  if (!services.tablebase || typeof services.tablebase.probe !== 'function'
    || typeof services.scorePolicyValue !== 'function') throw new Error('Missing contender search services');

  const now = typeof services.now === 'function' ? services.now : () => performance.now();
  const started = now(), position = new FastPosition(state);
  const rootMoves = legalActions.map(actionCode);
  const budgetMs = Math.max(0, finite(request.budgetMs, 60000));
  const maxTimeMs = integer(config.maxTimeMs, 360, 0, 55000);
  const allotted = Math.min(budgetMs, maxTimeMs);
  const reserveMs = Math.max(10, Math.min(1000, allotted * 0.05));
  const deadline = started + Math.max(0, allotted - reserveMs);
  const maxDepth = integer(config.maxDepth, 32, 1, 64);
  const maxNodes = integer(config.maxNodes, 160000, 1, 1000000);
  const tableLimit = integer(config.tableEntries, 8192, 0, 32768);
  const quiescenceDepth = integer(config.quiescenceDepth, 5, 0, 10);
  const maxProofNodes = integer(config.rootProofNodes, 1000, 0, 50000);
  const maxProofDepth = integer(config.proofDepth, 12, 0, 64);
  const maxProofMs = integer(config.proofTimeMs, 80, 0, 1000);
  let nodes = 0, tablebaseProbes = 0, historyProbes = 0, unsupportedProbes = 0;
  let policyEvals = 0, proofNodes = 0, provenWin = false, proofCompleted = false, completedDepth = 0;
  let chosen = rootMoves[0], score = 0;
  const policyCache = new Map();

  function result(info = {}) {
    return { action: decodeAction(chosen), info: {
      nodes, tablebaseProbes, historyProbes, unsupportedProbes, policyEvals, proofNodes,
      provenWin, proofCompleted, completedDepth, score,
      searchMs: Math.max(0, now() - started), ...info,
    } };
  }
  if (allotted <= reserveMs || now() >= deadline) return result();

  const tablebase = {
    probe(p) { tablebaseProbes++; return services.tablebase.probe(p); },
    probeKey(key) {
      historyProbes++;
      return typeof services.tablebase.probeKey === 'function' ? services.tablebase.probeKey(key) : 0;
    },
  };

  function policy(position, moves) {
    const key = `${position.key()}:${position.counts.get(position.key()) || 1}`;
    let entry = policyCache.get(key);
    if (entry) return entry;
    const raw = services.scorePolicyValue(position, moves, position.counts.get(position.key()) || 1);
    const value = finite(raw?.value, 0);
    const priors = Array.isArray(raw?.priors) && raw.priors.length === moves.length
      ? raw.priors.map(item => finite(item, 0)) : moves.map(() => 0);
    entry = { value, priors };
    policyCache.set(key, entry);
    policyEvals++;
    return entry;
  }

  function order(position, moves, preferred) {
    if (moves.length < 2) return moves;
    const priors = policy(position, moves).priors;
    return moves.map((move, index) => ({ move, index, rank: priors[index] + (move === preferred ? 1e12 : 0) }))
      .sort((a, b) => b.rank - a.rank || a.index - b.index).map(item => item.move);
  }

  function classify(position) {
    const outcome = classifyTablebase(position, tablebase);
    if (!outcome) unsupportedProbes++;
    return outcome;
  }

  function checkpoint() {
    if (nodes >= maxNodes || now() >= deadline) throw STOP;
    nodes++;
  }

  // DFPN can establish a forced win in an unsupported root, but a disproof or
  // depth cutoff says nothing about which side wins the actual game.
  const rootOutcome = classify(position);
  if (now() >= deadline) return result();
  if (!rootOutcome && maxProofNodes > 0 && maxProofDepth > 0 && typeof services.proveWin === 'function') {
    const proofDeadline = Math.min(deadline, now() + maxProofMs);
    if (proofDeadline - now() > 10) {
      try {
        const proof = services.proveWin(position, state.turn, {
          maxNodes: maxProofNodes,
          maxDepth: maxProofDepth,
          check() { if (now() >= proofDeadline) throw STOP; },
        });
        proofCompleted = true;
        proofNodes = integer(proof?.nodes, 0, 0, 1000000);
        if (proof?.status === 'win' && rootMoves.includes(proof.move)) {
          chosen = proof.move;
          provenWin = true;
          completedDepth = 1;
          score = MATE - 1;
          return result();
        }
      } catch (error) { if (error !== STOP) throw error; }
    }
  }

  let rootPolicy;
  try {
    if (now() >= deadline) return result();
    rootPolicy = policy(position, rootMoves);
  } catch (error) {
    if (error !== STOP) throw error;
    return result();
  }
  let rootOrder = orderFromPriors(rootMoves, rootPolicy.priors);
  const tt = new Map();
  const historyIds = new Map();
  const keyId = key => {
    if (!historyIds.has(key)) historyIds.set(key, historyIds.size);
    return historyIds.get(key);
  };
  function contextKey(ply) {
    const counts = [...position.counts].map(([key, count]) => [keyId(key), count]).sort((a, b) => a[0] - b[0]);
    return `${position.key()}|${ply}|${counts.map(([id, count]) => `${id}:${count}`).join(',')}`;
  }
  function withMove(move, callback) {
    const undo = position.make(move);
    try { return callback(); } finally { position.unmake(undo); }
  }
  const advance = (square, side) => side === 0 ? square % 4 : 3 - square % 4;
  function tactical(move) {
    const from = Math.floor(move / 12), to = move % 12, side = position.turn;
    const piece = from < 12 ? position.board[from] : side * 8 + from - 10;
    const kind = piece & 7, promoted = from < 12 && kind === 4 && advance(to, side) === 3;
    const resulting = promoted ? side * 8 + 5 : piece;
    const givesCheck = !!(MASKS[resulting][to] & (1 << position.kings[side ^ 1]));
    return !!position.board[to] || promoted || kind === 1 && advance(to, side) === 3 || givesCheck;
  }
  function quiescence(alpha, beta, remaining, ply, suppliedMoves, knownOutcome) {
    checkpoint();
    const moves = suppliedMoves || position.actions();
    const outcome = knownOutcome === undefined ? classify(position) : knownOutcome;
    if (outcome?.terminal) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply);
    if (outcome?.certain) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply - outcome.distance);
    const inCheck = position.inCheck();
    // A non-draw oracle result that becomes repetition-uncertain must not tie
    // a certified draw: the side to move may still force its oracle result.
    const stand = inCheck ? null : outcome ? outcome.outcome : policy(position, moves).value;
    if (remaining <= 0 && !inCheck) return stand;
    let best = inCheck ? -INF : stand;
    if (!inCheck) {
      if (stand >= beta) return stand;
      alpha = Math.max(alpha, stand);
    }
    const candidates = inCheck ? moves : moves.filter(tactical);
    if (!candidates.length) return stand;
    for (const move of order(position, candidates)) {
      const value = withMove(move, () => -quiescence(-beta, -alpha, remaining - 1, ply + 1));
      best = Math.max(best, value);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return best;
  }
  function search(depth, alpha, beta, ply) {
    checkpoint();
    const moves = position.actions(), outcome = classify(position);
    if (outcome) {
      if (outcome.terminal) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply);
      if (outcome.certain) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply - outcome.distance);
      if (depth <= 0) return quiescence(alpha, beta, quiescenceDepth, ply, moves, outcome);
    }
    if (depth <= 0) return quiescence(alpha, beta, quiescenceDepth, ply, moves, outcome);

    const originalAlpha = alpha, originalBeta = beta;
    const key = contextKey(ply), cached = tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === 0) return cached.score;
      if (cached.flag === 1 && cached.score >= beta) return cached.score;
      if (cached.flag === 2 && cached.score <= alpha) return cached.score;
    }
    let best = -INF, first = true, bestMove;
    const ordered = order(position, moves, cached?.move);
    for (const move of ordered) {
      const value = withMove(move, () => {
        if (first) return -search(depth - 1, -beta, -alpha, ply + 1);
        let result = -search(depth - 1, -alpha - 1, -alpha, ply + 1);
        if (result > alpha && result < beta) result = -search(depth - 1, -beta, -alpha, ply + 1);
        return result;
      });
      first = false;
      if (value > best) { best = value; bestMove = move; }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    if (tableLimit > 0) {
      if (tt.size >= tableLimit) tt.delete(tt.keys().next().value);
      tt.set(key, { depth, score: best, move: bestMove, flag: best <= originalAlpha ? 2 : best >= originalBeta ? 1 : 0 });
    }
    return best;
  }
  function rootSearch(depth, alpha, beta) {
    let best = -INF, bestMove = rootOrder[0], first = true;
    for (const move of rootOrder) {
      checkpoint();
      const value = withMove(move, () => {
        if (first) return -search(depth - 1, -beta, -alpha, 1);
        let result = -search(depth - 1, -alpha - 1, -alpha, 1);
        if (result > alpha && result < beta) result = -search(depth - 1, -beta, -alpha, 1);
        return result;
      });
      first = false;
      if (value > best) { best = value; bestMove = move; }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return { score: best, move: bestMove };
  }

  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      const result = rootSearch(depth, -INF, INF);
      chosen = result.move;
      score = result.score;
      completedDepth = depth;
      rootOrder = [chosen, ...rootOrder.filter(move => move !== chosen)];
      if (Math.abs(score) >= MATE - depth - 1) break;
    }
  } catch (error) { if (error !== STOP) throw error; }
  return result();
}

function orderFromPriors(moves, priors) {
  return moves.map((move, index) => ({ move, index, prior: finite(priors[index], 0) }))
    .sort((a, b) => b.prior - a.prior || a.index - b.index).map(item => item.move);
}
