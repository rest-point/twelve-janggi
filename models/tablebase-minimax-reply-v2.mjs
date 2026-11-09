import { FastPosition, actionCode } from './pvs-aspiration-rules-v1.mjs';
import { think as pvs } from './pvs-aspiration-v1.mjs';
import { openFullTablebase } from './full-tablebase-v2.mjs';

const table = openFullTablebase();
const tier = value => value === null ? -0.5 : value;

export function analyze(request, database = table) {
  const { state, legalActions, config = {} } = request;
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now();
  const budget = Number.isFinite(request.budgetMs) ? Math.max(0, request.budgetMs) : 60000;
  const maxTime = Number.isFinite(config.maxTimeMs) ? Math.max(0, config.maxTimeMs) : 360;
  const profileTime = Number.isFinite(config.tablebaseMaxMs) ? Math.max(0, config.tablebaseMaxMs) : 32;
  if (Math.min(budget, maxTime) <= 10) return pvs(request);
  const position = new FastPosition(state), repeated = new Map();
  let probes = 0;

  function withMove(move, callback) {
    const undo = position.make(move);
    try { return callback(); } finally { position.unmake(undo); }
  }
  function outcome() {
    probes++;
    const winner = position.winner();
    if (winner !== null) {
      const value = winner === 'draw' ? 0 : winner === state.turn ? 1 : -1;
      return { value, distance: 0, certain: true, terminal: true };
    }
    const raw = database.probe(position);
    if (!raw) return { value: null, distance: Infinity, certain: false };
    if (raw === 1) return { value: 0, distance: Infinity, certain: true };
    const value = Math.sign(raw) * (position.turn === state.turn ? 1 : -1);
    const distance = Math.abs(raw) - 256;
    let certain = true;
    // A board win/loss can become a draw if a prior twice-seen position
    // occurs again. Following decreasing ranks preserves at least a draw.
    for (const [key, count] of position.counts) {
      if (count < 2) continue;
      if (!repeated.has(key)) repeated.set(key, database.probeKey(key));
      const previous = repeated.get(key);
      if (Math.abs(previous) >= 256 && Math.abs(previous) - 256 < distance) { certain = false; break; }
    }
    return { value, distance, certain };
  }
  function output(action, source, info = {}) {
    return { action, source, info: { ...info, nodes: probes + (info.nodes ?? 0), searchMs: performance.now() - started } };
  }

  // Finish this small scan before allocating time to any tie-break. Partial
  // profiling may change the tie-break, but cannot undo a known safe choice.
  const candidates = legalActions.map(action => {
    const move = actionCode(action);
    return { action, move, ...withMove(move, outcome) };
  });
  const bestTier = Math.max(...candidates.map(candidate => tier(candidate.value)));
  let eligible = candidates.filter(candidate => tier(candidate.value) === bestTier);
  if (bestTier === 1) {
    const best = eligible.reduce((a, b) => (a.certain !== b.certain ? a.certain : a.distance <= b.distance) ? a : b);
    return output(best.action, 'tablebase-win');
  }

  // Compare the fraction of opponent replies giving us a proven win, and
  // avoid replies that could still lose. Use the profile only if all tied
  // candidates were scanned; a timeout must not favor the first candidates.
  const deadline = started + Math.min(profileTime, maxTime, budget - 10);
  const profiles = [];
  if (eligible.length > 1 && bestTier !== tier(null)) {
    for (const candidate of eligible) {
      if (performance.now() >= deadline) break;
      const profile = candidate.terminal ? { risk: 0, upside: 0 } : withMove(candidate.move, () => {
        const replies = position.actions();
        let risk = 0, upside = 0;
        for (const reply of replies) {
          if (performance.now() >= deadline) return null;
          const result = withMove(reply, outcome);
          if (result.value === -1 || result.value === null) risk++;
          if (result.value === 1 && result.certain) upside++;
        }
        return { risk: risk / replies.length, upside: upside / replies.length };
      });
      if (!profile) break;
      profiles.push({ candidate, ...profile });
    }
  }
  if (profiles.length > 1 && profiles.length === eligible.length) {
    profiles.sort((a, b) => a.risk - b.risk || b.upside - a.upside);
    const best = profiles[0];
    eligible = profiles.filter(profile => profile.risk === best.risk && profile.upside === best.upside).map(profile => profile.candidate);
  }
  if (eligible.length === 1) return output(eligible[0].action, 'tablebase');
  const elapsed = performance.now() - started;
  const result = pvs({ ...request, legalActions: eligible.map(candidate => candidate.action), budgetMs: Math.max(0, budget - elapsed),
    config: { ...config, maxTimeMs: Math.max(0, maxTime - elapsed) } });
  return output(result.action, 'pvs', result.info);
}

export function think(request) {
  const { action, info } = analyze(request);
  return { action, info };
}
