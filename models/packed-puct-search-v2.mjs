import { FastPosition, actionCode, decodeAction } from './pvs-aspiration-rules-v1.mjs';
import { solveWin } from './dfpn-proof-v1.mjs';

const STOP = Symbol('batch search deadline');
const int = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
const num = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

function updateProof(node) {
  if (node.proven !== null) return;
  let allKnown = true, draw = false;
  for (let i = 0; i < node.actions.length; i++) {
    const child = node.children[i];
    if (child?.proven === -1) { node.proven = 1; node.proofMove = node.actions[i]; return; }
    if (!child || child.pending || child.proven === null) allKnown = false;
    if (child?.proven === 0) draw = true;
  }
  if (allKnown) node.proven = draw ? 0 : -1;
}

function backup(path, value) {
  for (let i = path.length - 1; i >= 0; i--) {
    const [node, edge] = path[i];
    value = 1 - value;
    node.N[edge]++; node.W[edge] += value; node.n++; node.sum += value;
    updateProof(node);
    if (node.proven !== null) value = (node.proven + 1) / 2;
  }
}

/** Diagnostic search API also permits a synchronous, compatible NN backend. */
export function searchBatch({ state, legalActions, budgetMs = 60000, config = {} }, evaluate) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now(), budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 60000;
  const reserve = Math.max(10, Math.min(1000, budget * 0.05));
  const deadline = started + Math.max(0, Math.min(int(config.maxTimeMs, 1000, 0, 55000), budget - reserve));
  const limit = int(config.simulations, 1200, 1, 10000), batchSize = int(config.batchSize, 8, 1, 32);
  const maxDepth = int(config.maxDepth, 96, 1, 192), proofDepth = int(config.proofDepth, 12, 1, 32);
  const rootProof = int(config.rootProofNodes, 5000, 0, 50000), leafProof = int(config.leafProofNodes, 40, 0, 1000);
  const replyProof = int(config.replyProofNodes, 0, 0, 5000);
  const rootCoverage = int(config.rootCoverage, 0, 0, 8);
  const cacheSize = int(config.cacheEntries, 2048, 0, 8192), temperature = num(config.policyTemperature, 1, 0.1, 5);
  const cInit = num(config.cInit, 1.44, 0, 5), cBase = num(config.cBase, 28288, 1, 100000);
  const cRoot = num(config.cInitRoot, 1.16, 0, 5), baseRoot = num(config.cBaseRoot, 25617, 1, 100000);
  const fpu = num(config.fpuReduction, 0.27, 0, 1), virtualLoss = num(config.virtualLoss, 1, 0.1, 4);
  const rootValuePenalty = num(config.rootValuePenalty, -1, -1, 1);
  const p = new FastPosition(state), rootActions = legalActions.map(actionCode), cache = new Map();
  if (p.winner(rootActions) !== null) throw new Error('No legal actions: terminal position');
  let chosen = rootActions[0], root, nodes = 0, completed = 0, reserved = 0, nnBatches = 0, nnRows = 0, largestBatch = 0, discarded = 0;
  const check = () => { if (performance.now() >= deadline) throw STOP; };
  function withMove(move, fn) { const undo = p.make(move); try { return fn(); } finally { p.unmake(undo); } }
  function proof(limit) {
    if (!limit) return null;
    let result, entered = 0;
    try { result = solveWin(p, p.turn, { maxNodes: limit, maxDepth: proofDepth, check() { check(); entered++; } }); }
    finally { nodes += Math.min(limit, entered); }
    return result.status === 'win' ? result : null;
  }
  function remember(key, prediction) {
    if (!cacheSize) return;
    if (!cache.has(key) && cache.size >= cacheSize) cache.delete(cache.keys().next().value);
    cache.set(key, prediction);
  }
  function initialize(node, prediction) {
    if (!prediction || !Number.isFinite(prediction.value) || prediction.prior.length !== node.actions.length
      || !prediction.prior.every(Number.isFinite)) throw new Error('Invalid batch neural output');
    node.value = (prediction.value + 1) / 2; node.prior = prediction.prior; node.pending = false;
  }
  function prepare(actions, proofLimit) {
    check(); nodes++;
    actions ||= p.actions();
    const winner = p.winner(actions);
    if (winner !== null) return { node: { proven: winner === 'draw' ? 0 : winner === p.turn ? 1 : -1 } };
    const win = proof(proofLimit);
    if (win) return { node: { proven: 1, proofMove: win.move } };
    const positionKey = p.key(), count = p.counts.get(positionKey) || 0;
    const key = positionKey + ':' + Math.min(2, count) + ':' + actions.join(',');
    const node = { proven: null, pending: true, actions, n: 0, sum: 0, virtualTotal: 0,
      N: new Uint32Array(actions.length), W: new Float64Array(actions.length),
      V: new Uint32Array(actions.length), children: new Array(actions.length) };
    const cached = cache.get(key);
    if (cached) { initialize(node, cached); return { node }; }
    // The NN reads only these features. The full search history stays in p;
    // this immutable snapshot survives restoring p before batch inference.
    const position = { board: p.board.slice(), hands: p.hands.slice(), turn: p.turn,
      counts: new Map([[positionKey, count]]), key: () => positionKey };
    return { node, key, query: { position, actions } };
  }
  function infer(tasks) {
    check(); nnBatches++; nnRows += tasks.length; largestBatch = Math.max(largestBatch, tasks.length);
    const predictions = evaluate(tasks.map(task => task.query), temperature);
    check();
    if (predictions.length !== tasks.length) throw new Error('Invalid batch result count');
    for (let i = 0; i < tasks.length; i++) {
      initialize(tasks[i].node, predictions[i]); remember(tasks[i].key, predictions[i]);
    }
  }
  function release(path) {
    for (const [node, edge] of path) {
      if (!node.V[edge] || !node.virtualTotal) throw new Error('Unbalanced virtual loss');
      node.V[edge]--; node.virtualTotal--; reserved--;
    }
  }
  function select(node) {
    if (node === root && rootCoverage) {
      let underexplored = -1;
      for (let i = 0; i < node.actions.length; i++) {
        const child = node.children[i];
        if (child?.pending || child?.proven === 1 || node.N[i] + node.V[i] >= rootCoverage) continue;
        if (underexplored < 0 || node.prior[i] > node.prior[underexplored]) underexplored = i;
      }
      if (underexplored >= 0) return underexplored;
    }
    const total = node.n + virtualLoss * node.virtualTotal;
    const base = node === root ? baseRoot : cBase, initial = node === root ? cRoot : cInit;
    const exploration = (Math.log((total + base + 1) / base) + initial) * Math.sqrt(total || 1);
    let visitedMass = 0;
    for (let i = 0; i < node.actions.length; i++) if (node.N[i] + node.V[i]) visitedMass += node.prior[i];
    const firstValue = Math.max(0, (total ? node.sum / total : node.value) - (node === root ? 0 : fpu) * Math.sqrt(visitedMass));
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < node.actions.length; i++) {
      const child = node.children[i];
      if (child?.pending || child?.proven === 1) continue;
      const visits = node.N[i] + virtualLoss * node.V[i];
      // Reservations contribute a temporary zero-win sample, lowering Q.
      const q = visits ? node.W[i] / visits : firstValue;
      const score = q + exploration * node.prior[i] / (1 + visits);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }
  function principal(byValue = false) {
    if (root.proven === 1 && root.proofMove !== undefined) return root.proofMove;
    let best = -1;
    for (let i = 0; i < root.actions.length; i++) {
      if (root.children[i]?.proven === 1) continue;
      if (best < 0 || root.N[i] > root.N[best] || root.N[i] === root.N[best] && root.prior[i] > root.prior[best]) best = i;
    }
    if (byValue && rootValuePenalty >= 0 && root.n >= 32) {
      let bestValue = -Infinity, valueMove = -1;
      const minVisits = Math.max(8, Math.ceil(root.n * 0.02));
      for (let i = 0; i < root.actions.length; i++) {
        const solved = root.children[i]?.proven;
        if (solved === 1 || (solved !== 0 && root.N[i] < minVisits)) continue;
        const value = solved === 0 ? 0.5 : root.W[i] / root.N[i] - rootValuePenalty / Math.sqrt(root.N[i]);
        if (value > bestValue) { bestValue = value; valueMove = i; }
      }
      if (valueMove >= 0) best = valueMove;
    }
    return root.actions[best < 0 ? 0 : best];
  }
  function collect() {
    const path = [], undos = [];
    let node = root, handedOff = false;
    try {
      for (let depth = 0;; depth++) {
        check();
        if (node.proven !== null || depth >= maxDepth) {
          handedOff = true; return { node, path, held: true };
        }
        const edge = select(node);
        if (edge < 0) return null; // All usable continuations await this batch.
        node.V[edge]++; node.virtualTotal++; reserved++;
        path.push([node, edge]); undos.push(p.make(node.actions[edge]));
        if (!node.children[edge]) {
          const task = prepare(undefined, leafProof);
          node.children[edge] = task.node;
          handedOff = true; return { ...task, path, held: true };
        }
        node = node.children[edge];
      }
    } finally {
      while (undos.length) p.unmake(undos.pop());
      if (!handedOff) release(path);
    }
  }
  function commit(task) {
    release(task.path); task.held = false;
    const value = task.node.proven === null ? task.node.value : (task.node.proven + 1) / 2;
    backup(task.path, value); completed++; chosen = principal();
  }
  try {
    for (let i = 0; i < rootActions.length; i++) {
      check(); nodes++;
      if (withMove(rootActions[i], () => p.winner()) === state.turn) {
        chosen = rootActions[i];
        return result(1);
      }
    }
    const safeActions = [];
    for (const action of rootActions) {
      check();
      const safe = withMove(action, () => {
        const replies = p.actions(), winner = p.winner(replies);
        if (winner !== null) return true;
        const opponent = p.turn;
        for (const reply of replies) {
          check(); nodes++;
          if (withMove(reply, () => p.winner()) === opponent) return false;
        }
        return !proof(replyProof);
      });
      if (safe) {
        if (!safeActions.length) chosen = action;
        safeActions.push(action);
      }
    }
    // Discard only proven losses when at least one move remains unresolved
    // or safe. Preserve a legal fallback when all replies are refuted.
    if (safeActions.length) chosen = safeActions[0];
    const first = prepare(safeActions.length ? safeActions : rootActions, rootProof); root = first.node;
    if (root.proven === 1) chosen = root.proofMove;
    else {
      if (first.query) infer([first]);
      chosen = principal();
      while (completed < limit && root.proven === null) {
        check();
        const tasks = [];
        try {
          for (let attempts = 0; attempts < batchSize * 4 + 8 && tasks.length < batchSize
            && completed + tasks.length < limit && root.proven === null; attempts++) {
            const task = collect();
            if (!task) { discarded++; break; }
            if (task.query) tasks.push(task); else commit(task);
          }
          if (root.proven !== null) break;
          if (tasks.length) { infer(tasks); for (const task of tasks) commit(task); }
        } finally { for (const task of tasks) if (task.held) release(task.path); }
      }
    }
  } catch (error) { if (error !== STOP) throw error; }
  return result();

  function result(proven = root?.proven ?? null) {
    if (root?.n >= 32 && rootValuePenalty >= 0) chosen = principal(true);
    const visits = root?.N ? Array.from(root.N) : [];
    if (root?.children?.some(child => child?.proven !== 1)) {
      for (let i = 0; i < visits.length; i++) if (root.children[i]?.proven === 1) visits[i] = 0;
    }
    return { action: decodeAction(chosen),
      root: { actions: root?.actions ?? rootActions, visits, proven, chosen,
        values: root?.N ? Array.from(root.N, (n, i) => {
          const solved = root.children[i]?.proven;
          return solved != null ? (1 - solved) / 2 : n ? root.W[i] / n : root.value;
        }) : [] },
      info: { nodes, searchMs: performance.now() - started },
      diagnostics: { completedSimulations: completed, nnBatches, nnRows, largestBatch, virtualReservations: reserved, discarded } };
  }
}
