import { fromEngine, historyFromEngine, fromEngineAction, toEngineAction, legal, step, verdict, features, canonAction, forward, N_POLICY } from './azero-core.mjs';

// A proof is always from the side-to-move perspective: -1 loss, 0 draw,
// 1 win. Neural values are estimates and never become proof by themselves.
const STOP = Symbol('time or node limit');
const integer = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

export function search(request, weights) {
  const { state, legalActions, config = {} } = request;
  const started = performance.now();
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const budget = Number.isFinite(request.budgetMs) ? Math.max(0, request.budgetMs) : 0;
  const reserve = Math.max(100, Math.min(3000, budget * 0.05));
  const maxTimeMs = integer(config.maxTimeMs, 57000, 0, 57000);
  const deadline = started + Math.max(0, Math.min(maxTimeMs, budget - reserve));
  const simulations = integer(config.sims, 800, 0, 1000000);
  const maxNodes = integer(config.maxNodes, 801, 1, 30000);
  const cpuct = Number.isFinite(config.cpuct) ? Math.max(0, Math.min(10, config.cpuct)) : 1.5;
  const rootState = fromEngine(state), seen = historyFromEngine(state);
  const rootActions = legalActions.map(fromEngineAction);
  const actualRootActions = legal(rootState);
  if (verdict(rootState, actualRootActions, seen.get(rootState.key) || 1, Infinity) !== null) throw new Error('No legal actions');
  let chosen = rootActions[0], proven = null, created = 0, completed = 0, maxDepth = 0, tacticalNodes = 0, root = null;

  function check() { if (performance.now() >= deadline) throw STOP; }
  function inHistory(key, fn) {
    const old = seen.get(key) || 0;
    seen.set(key, old + 1);
    try { return fn(old + 1); }
    finally { if (old) seen.set(key, old); else seen.delete(key); }
  }
  function finish() {
    // A clock interruption can happen at any depth. Publish the best explored
    // root action even when STOP unwinds the search before its normal exit.
    if (root) {
      proven = root.proven;
      const forcedWin = root.children.findIndex(child => child?.proven === -1);
      if (forcedWin >= 0) chosen = root.acts[forcedWin];
      else {
        let best = -1;
        for (let i = 0; i < root.acts.length; i++) {
          if (root.proven !== -1 && root.children[i]?.proven === 1) continue;
          if (root.proven === 0 && root.children[i]?.proven !== 0) continue;
          if (best < 0 || root.N[i] > root.N[best] || (root.N[i] === root.N[best] && root.N[i] && root.W[i] / root.N[i] > root.W[best] / root.N[best])) best = i;
        }
        if (best >= 0) chosen = root.acts[best];
      }
    }
    const candidates = root ? root.acts.map((a, i) => ({
      action: toEngineAction(a), visits: root.N[i],
      value: root.N[i] ? root.W[i] / root.N[i] : null,
      proven: root.children[i]?.proven === null || root.children[i] === undefined ? null : root.children[i].proven === 0 ? 0 : -root.children[i].proven,
    })) : [];
    return { action: toEngineAction(chosen), proven, simulations: completed, tacticalNodes, candidates,
      info: { nodes: created, completedDepth: maxDepth, searchMs: performance.now() - started } };
  }
  const logits = new Float64Array(N_POLICY);
  function makeNode(s, movesOverride) {
    const allMoves = legal(s), terminal = verdict(s, allMoves, seen.get(s.key) || 1, Infinity);
    created++;
    if (terminal !== null) return { proven: terminal, value: terminal, key: s.key };
    const acts = movesOverride || allMoves;
    const raw = forward(weights, features(s, seen.get(s.key) || 1), acts.map(a => canonAction(a, s.t)), logits);
    let top = -Infinity, total = 0;
    for (let i = 0; i < acts.length; i++) top = Math.max(top, logits[i]);
    const P = new Float32Array(acts.length);
    for (let i = 0; i < acts.length; i++) total += P[i] = Math.exp(logits[i] - top);
    for (let i = 0; i < acts.length; i++) P[i] /= total;
    return { s, key: s.key, acts, P, N: new Int32Array(acts.length), W: new Float32Array(acts.length),
      children: new Array(acts.length), n: 0, sum: 0, value: Math.tanh(raw), proven: null };
  }
  function updateProof(node) {
    let allSolved = true, best = -1;
    for (const child of node.children) {
      if (!child || child.proven === null) { allSolved = false; continue; }
      best = Math.max(best, child.proven === 0 ? 0 : -child.proven);
      if (best === 1) { node.proven = 1; return; }
    }
    if (allSolved) node.proven = best;
  }
  function select(node) {
    const exploration = cpuct * Math.sqrt(node.n + 1);
    const firstPlay = (node.n ? node.sum / node.n : node.value) - 0.2;
    let selected = -1, best = -Infinity;
    for (let i = 0; i < node.acts.length; i++) {
      // A solved child needs no more samples. Its exact result is propagated.
      if (node.children[i] && node.children[i].proven !== null) continue;
      const q = node.N[i] ? node.W[i] / node.N[i] : firstPlay;
      const u = q + exploration * node.P[i] / (1 + node.N[i]);
      if (selected < 0 || u > best) { selected = i; best = u; }
    }
    return selected;
  }

  try {
    check();
    const safe = [];
    // The root preflight proves immediate wins and excludes a move only when
    // the opponent has an actual legal, immediate winning response.
    for (const action of rootActions) {
      check();
      const next = step(rootState, action); tacticalNodes++;
      const outcome = inHistory(next.key, count => {
        const replies = legal(next), result = verdict(next, replies, count, Infinity);
        if (result !== null) return result === -1 ? 'win' : result === 0 ? 'safe' : 'loss';
        for (const reply of replies) {
          check();
          const after = step(next, reply); tacticalNodes++;
          const response = inHistory(after.key, seenCount => verdict(after, legal(after), seenCount, Infinity));
          if (response === -1) return 'loss';
        }
        return 'safe';
      });
      if (outcome === 'win') { chosen = action; proven = 1; maxDepth = 1; return finish(); }
      if (outcome === 'safe') {
        // A later deadline must not discard an already verified safe action.
        if (!safe.length) chosen = action;
        safe.push(action);
      }
    }
    if (!safe.length) { proven = -1; maxDepth = 2; return finish(); }
    chosen = safe[0];
    if (safe.length === 1) return finish();
    check();
    root = makeNode(rootState, safe);
    for (let iteration = 0; iteration < simulations && root.proven === null; iteration++) {
      check();
      let current = root, value, depth = 0, limited = false;
      const path = [], added = [];
      try {
        for (;;) {
          check();
          const index = select(current);
          if (index < 0) { updateProof(current); value = current.proven; break; }
          let child = current.children[index];
          if (!child && created >= maxNodes) { limited = true; break; }
          path.push([current, index]);
          if (!child) {
            const next = step(current.s, current.acts[index]);
            const old = seen.get(next.key) || 0;
            seen.set(next.key, old + 1); added.push([next.key, old]);
            child = current.children[index] = makeNode(next);
            depth++;
            value = child.proven === null ? child.value : child.proven;
            break;
          }
          const old = seen.get(child.key) || 0;
          seen.set(child.key, old + 1); added.push([child.key, old]);
          depth++;
          current = child;
        }
        if (limited) break;
        maxDepth = Math.max(maxDepth, depth);
        for (let d = path.length - 1; d >= 0; d--) {
          const [node, index] = path[d];
          value = -value;
          node.N[index]++; node.W[index] += value; node.n++; node.sum += value;
          updateProof(node);
          if (node.proven !== null) value = node.proven;
        }
        completed++;
      } finally {
        for (let i = added.length - 1; i >= 0; i--) {
          const [key, old] = added[i];
          if (old) seen.set(key, old); else seen.delete(key);
        }
      }
    }
  } catch (error) { if (error !== STOP) throw error; }
  return finish();
}
