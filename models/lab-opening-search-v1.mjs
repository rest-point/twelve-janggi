import { initialState, applyAction, positionKey } from '../src/engine.js';
import { think as fallback } from './azero-v2.mjs';

// Probe a single opening decision, then use the immutable original v2 policy.
// Match the actual initial history as well as the board/turn, never arbitrary
// edited positions or later repetitions of the opening board.
const openings = new Map();
for (const first of [0, 1]) {
  const start = initialState(first), initialKey = positionKey(start);
  openings.set(initialKey, { ply: 0, initialKey });
  const next = applyAction(start, first === 0 ? { from: 5, to: 6 } : { from: 6, to: 5 }, false);
  openings.set(positionKey(next), { ply: 1, initialKey });
}
export function think(request) {
  const started = performance.now(), { state, legalActions, config } = request;
  const index = config.openingIndex;
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('Invalid opening index');
  const key = positionKey(state), opening = openings.get(key);
  if (opening && state.ply === opening.ply && state.positions.length === state.ply + 1
    && state.positions[0] === opening.initialKey && state.positions.at(-1) === key) {
    if (!legalActions[index]) throw new Error('Opening action missing');
    return { action: { ...legalActions[index] }, info: { nodes: 0, completedDepth: 0, searchMs: performance.now() - started } };
  }
  return fallback(request);
}
