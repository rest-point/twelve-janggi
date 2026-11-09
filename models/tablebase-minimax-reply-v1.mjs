import { readFileSync } from 'node:fs';
import { FastPosition, actionCode } from './pvs-aspiration-rules-v1.mjs';
import { think as pvs } from './pvs-aspiration-v1.mjs';
import { loadTablebase, probeTablebase } from './strict-tablebase-v1.mjs';

const tablebase = loadTablebase(readFileSync(new URL('./tablebase-minimax-reply-v1.bin', import.meta.url)));
const tier = value => value === null ? -0.5 : value;

function compareReplies(a, b) {
  // Keep unknown replies in the risk bound. A sparsely covered line must
  // not appear safer simply because fewer opponent wins were verified.
  const risk = p => p ? (p.losses + p.unknown) / p.total : 1;
  const upside = p => p ? p.wins / p.total : 0;
  return risk(b) - risk(a) || upside(a) - upside(b);
}

export function analyze(request, table = tablebase) {
  const { state, legalActions, config = {} } = request;
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now();
  const budget = Number.isFinite(request.budgetMs) ? Math.max(0, request.budgetMs) : 60000;
  const maxTime = Number.isFinite(config.maxTimeMs) ? Math.max(0, config.maxTimeMs) : 360;
  const tableTime = Number.isFinite(config.tablebaseMaxMs) ? Math.max(0, config.tablebaseMaxMs) : 16;
  const deadline = started + Math.max(0, Math.min(tableTime, maxTime, budget - 10));
  const position = new FastPosition(state);
  const candidates = legalActions.map(action => ({ action, move: actionCode(action), value: null, distance: Infinity }));
  let nodes = 0;

  function withMove(move, next) {
    const undo = position.make(move);
    try { return next(); } finally { position.unmake(undo); }
  }
  function lookup(actions) {
    nodes++;
    const winner = position.winner(actions);
    if (winner !== null) return { value: winner === 'draw' ? 0 : winner === state.turn ? 1 : -1, distance: 0, terminal: true };
    const known = probeTablebase(table, position);
    return known ? { value: position.turn === state.turn ? known.value : -known.value, distance: known.distance } : null;
  }
  function output(candidate, source, info = {}) {
    return { action: candidate.action, source, candidates,
      info: { ...info, nodes: nodes + (info.nodes ?? 0), searchMs: performance.now() - started } };
  }

  if (performance.now() < deadline) {
    const root = probeTablebase(table, position);
    if (root?.value === -1) for (const candidate of candidates) candidate.value = -1;
    if (root?.value === 1) {
      const proven = candidates.find(candidate => candidate.move === root.move);
      if (proven) Object.assign(proven, { value: 1, distance: root.distance });
    }
  }

  for (const candidate of candidates) {
    if (performance.now() >= deadline) break;
    const known = withMove(candidate.move, () => lookup());
    if (!known) continue;
    Object.assign(candidate, { value: known.value, distance: known.distance + 1, terminal: known.terminal });
    if (candidate.value === 1 && candidate.terminal) return output(candidate, 'terminal', { completedDepth: 1 });
    if (candidate.terminal) candidate.replies = { wins: 0, losses: Number(candidate.value === -1), unknown: 0, total: 1 };
  }

  if (!candidates.some(candidate => candidate.value === 1)) {
    for (const candidate of candidates) {
      if (performance.now() >= deadline) break;
      if (candidate.terminal) continue;
      withMove(candidate.move, () => {
        const replies = position.actions();
        const winner = position.winner(replies);
        if (winner !== null) return;
        const profile = { wins: 0, losses: 0, unknown: 0, total: replies.length };
        let worst = 1, distance = 0;
        for (const move of replies) {
          if (performance.now() >= deadline) return;
          const result = withMove(move, () => lookup());
          if (!result) { profile.unknown++; continue; }
          if (result.value === 1) profile.wins++;
          if (result.value === -1) profile.losses++;
          worst = Math.min(worst, result.value);
          distance = Math.max(distance, result.distance);
        }
        candidate.replies = profile;
        if (profile.losses || !profile.unknown) {
          candidate.value = worst;
          if (worst === 1) candidate.distance = distance + 2;
        }
      });
    }
  }

  const bestTier = Math.max(...candidates.map(candidate => tier(candidate.value)));
  let eligible = candidates.filter(candidate => tier(candidate.value) === bestTier);
  if (bestTier === 1) {
    const best = eligible.reduce((a, b) => a.distance <= b.distance ? a : b);
    return output(best, 'proven-win');
  }
  if (bestTier !== tier(null)) {
    const best = eligible.reduce((a, b) => compareReplies(a.replies, b.replies) >= 0 ? a : b);
    eligible = eligible.filter(candidate => compareReplies(candidate.replies, best.replies) === 0);
    if (eligible.length === 1) return output(best, 'reply-profile');
  }
  const elapsed = performance.now() - started;
  const result = pvs({ ...request, legalActions: eligible.map(candidate => candidate.action),
    budgetMs: Math.max(0, budget - elapsed), config: { ...config, maxTimeMs: Math.max(0, maxTime - elapsed) } });
  const chosen = eligible.find(candidate => candidate.move === actionCode(result.action));
  return output(chosen, 'pvs', result.info);
}

export function think(request) {
  const { action, info } = analyze(request);
  return { action, info };
}
