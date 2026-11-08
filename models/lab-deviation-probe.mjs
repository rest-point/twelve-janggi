import { positionKey } from '../src/engine.js';
import { think as fallback } from './azero-v2.mjs';

// Research-only single-decision policy intervention. The immutable default
// policy resumes immediately afterwards. Final deployments use a separate book.
export function think(request) {
  const { state, legalActions, config } = request;
  if (state.ply === config.probePly && positionKey(state) === config.positionKey
    && JSON.stringify(state.positions) === config.historyKey) {
    const action = legalActions.find(a => JSON.stringify(a) === JSON.stringify(config.action));
    if (!action) throw new Error('Invalid probe action');
    return { action, info: { nodes: 0, completedDepth: 0, searchMs: 0 } };
  }
  return fallback({ ...request, config: { sims: 800 } });
}
