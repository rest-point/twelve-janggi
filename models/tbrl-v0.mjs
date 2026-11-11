// Experimental baseline: tablebase-safe moves, 2-ply repetition avoidance, seeded random tie-break.
import { openTable, classify, safeCandidates, rng } from './tbrl-core.mjs';

const table = openTable();
export function think({ state, legalActions, seed }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now(), misses = table.misses;
  const { eligible } = safeCandidates(classify(state, legalActions, table));
  const child = eligible[Math.floor(rng(seed)() * eligible.length)];
  return { action: child.action, info: { nodes: legalActions.length + table.misses - misses, searchMs: performance.now() - started } };
}
