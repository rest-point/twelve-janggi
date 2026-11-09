import { FastPosition, actionCode, decodeAction } from './pvs-aspiration-rules-v1.mjs';
import { policyValue } from './pv-puct-network-v1.mjs';
import { solveWin } from './dfpn-proof-v1.mjs';

const STOP = Symbol('time budget');
const integer = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
const number = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

function updateProof(node) {
  if (node.proven !== null) return;
  let allKnown = true, anyDraw = false;
  for (let i = 0; i < node.actions.length; i++) {
    const child = node.children[i];
    if (child?.proven === -1) { node.proven = 1; node.proofMove = node.actions[i]; return; }
    if (!child || child.proven === null) allKnown = false;
    if (child?.proven === 0) anyDraw = true;
  }
  if (allKnown) node.proven = anyDraw ? 0 : -1;
}

/** Back up a completed simulation. Proven minimax outcomes supersede its sample. */
export function backupPath(path, value) {
  for (let i = path.length - 1; i >= 0; i--) {
    const [parent, edge] = path[i];
    value = 1 - value;
    if (parent.N[edge] === 0) parent.visitedPrior += parent.prior[edge];
    parent.N[edge]++; parent.W[edge] += value;
    parent.n++; parent.sum += value;
    updateProof(parent);
    // In particular, discovering the final losing alternative beside a known
    // draw proves a draw, even though the last sampled alternative lost.
    if (parent.proven !== null) value = (parent.proven + 1) / 2;
  }
}

/** Dynamic PUCT on a path-specific tree, plus sound bounded DFPN wins. */
export function think({ state, legalActions, budgetMs = 60000, config = {} }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now(), budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 60000;
  const reserve = Math.max(10, Math.min(1000, budget * 0.05));
  const deadline = started + Math.max(0, Math.min(integer(config.maxTimeMs, 1000, 0, 55000), budget - reserve));
  const simulations = integer(config.simulations, 1200, 1, 10000);
  const maxDepth = integer(config.maxDepth, 96, 1, 192);
  const rootProofNodes = integer(config.rootProofNodes, 5000, 0, 50000);
  const leafProofNodes = integer(config.leafProofNodes, 40, 0, 1000);
  const proofDepth = integer(config.proofDepth, 12, 1, 32);
  const cacheEntries = integer(config.cacheEntries, 2048, 0, 8192);
  const temperature = number(config.policyTemperature, 1, 0.1, 5);
  const cInit = number(config.cInit, 1.44, 0, 5), cBase = number(config.cBase, 28288, 1, 100000);
  const cInitRoot = number(config.cInitRoot, 1.16, 0, 5), cBaseRoot = number(config.cBaseRoot, 25617, 1, 100000);
  const fpuReduction = number(config.fpuReduction, 0.27, 0, 1);
  const p = new FastPosition(state), cache = new Map();
  if (p.winner(legalActions.map(actionCode)) !== null) throw new Error('No legal actions: terminal position');
  let nodes = 0, chosen = actionCode(legalActions[0]), root;
  const check = () => { if (performance.now() >= deadline) throw STOP; };
  function withMove(move, fn) {
    const undo = p.make(move);
    try { return fn(); } finally { p.unmake(undo); }
  }
  function prove(limit) {
    if (!limit) return null;
    let proof, entered = 0;
    try {
      proof = solveWin(p, p.turn, { maxNodes: limit, maxDepth: proofDepth, check() { check(); entered++; } });
    } finally {
      // DFPN checks before its node-limit test, hence one extra check at most.
      // Include completed visits even when an external deadline interrupts it.
      nodes += Math.min(limit, entered);
    }
    return proof.status === 'win' ? proof : null;
  }
  function makeNode(actions, proofLimit) {
    check(); nodes++;
    actions ||= p.actions();
    const winner = p.winner(actions);
    if (winner !== null) return { proven: winner === 'draw' ? 0 : winner === p.turn ? 1 : -1, n: 0 };
    const proof = prove(proofLimit);
    if (proof) return { proven: 1, proofMove: proof.move, n: 0 };
    // Only NN predictions are cached by its exact input (board/current count).
    // Search outcomes and visit statistics are never merged across histories.
    const key = p.key() + ':' + Math.min(2, p.counts.get(p.key()) || 0) + ':' + actions.join(',');
    let prediction = cache.get(key);
    if (!prediction) {
      prediction = policyValue(p, actions, temperature);
      if (cacheEntries) {
        if (cache.size >= cacheEntries) cache.delete(cache.keys().next().value);
        cache.set(key, prediction);
      }
    }
    return { proven: null, actions, prior: prediction.prior, value: (prediction.value + 1) / 2,
      n: 0, sum: 0, visitedPrior: 0, N: new Uint32Array(actions.length),
      W: new Float64Array(actions.length), children: new Array(actions.length) };
  }
  function select(node, isRoot) {
    const c = Math.log((node.n + (isRoot ? cBaseRoot : cBase) + 1) / (isRoot ? cBaseRoot : cBase)) + (isRoot ? cInitRoot : cInit);
    const fpu = Math.max(0, (node.n ? node.sum / node.n : node.value) - (isRoot ? 0 : fpuReduction) * Math.sqrt(node.visitedPrior));
    const exploration = c * Math.sqrt(node.n || 1);
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < node.actions.length; i++) {
      if (node.children[i]?.proven === 1) continue; // Opponent has a PROVEN win.
      const q = node.N[i] ? node.W[i] / node.N[i] : fpu;
      const score = q + exploration * node.prior[i] / (1 + node.N[i]);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    // All edges being proven losses also makes this node proven -1.
    return best < 0 ? 0 : best;
  }
  function principal(node) {
    if (node.proven === 1 && node.proofMove !== undefined) return node.proofMove;
    let best = -1;
    for (let i = 0; i < node.actions.length; i++) {
      if (node.children[i]?.proven === 1) continue;
      if (best < 0 || node.N[i] > node.N[best] || node.N[i] === node.N[best] && node.prior[i] > node.prior[best]) best = i;
    }
    // A losing root still has to return one of its legal moves.
    if (best < 0) best = 0;
    return node.actions[best];
  }
  try {
    // A complete, budgeted one-ply scan guarantees visible immediate wins.
    for (const action of legalActions) {
      check(); nodes++;
      const move = actionCode(action), winner = withMove(move, () => p.winner());
      if (winner === state.turn) return { action, info: { nodes, searchMs: performance.now() - started } };
    }
    root = makeNode(legalActions.map(actionCode), rootProofNodes);
    if (root.proven === 1) chosen = root.proofMove;
    else {
      chosen = principal(root);
      for (let sim = 0; sim < simulations && root.proven === null; sim++) {
        check();
        const path = [], undos = [];
        let node = root, value;
        try {
          for (let depth = 0;; depth++) {
            if (node.proven !== null) { value = (node.proven + 1) / 2; break; }
            if (depth >= maxDepth) { value = node.value; break; } // Horizon is NOT a draw/proof.
            check();
            const edge = select(node, node === root);
            undos.push(p.make(node.actions[edge]));
            path.push([node, edge]);
            let child = node.children[edge];
            if (!child) {
              child = makeNode(undefined, leafProofNodes);
              node.children[edge] = child;
              value = child.proven === null ? child.value : (child.proven + 1) / 2;
              break;
            }
            node = child;
          }
          // No partially evaluated simulation is ever backpropagated.
          backupPath(path, value);
          chosen = principal(root);
        } finally { while (undos.length) p.unmake(undos.pop()); }
      }
    }
  } catch (error) { if (error !== STOP) throw error; }
  // info counts root scan + created tree nodes + DFPN visits, not simulations.
  return { action: decodeAction(chosen), info: { nodes, searchMs: performance.now() - started } };
}
