import { applyAction } from '../src/engine.js';
const values = { king: 0, rook: 30, bishop: 25, pawn: 10, hen: 45 };
export function think({ state, legalActions }) {
  const side = state.turn;
  let best = -Infinity, action = legalActions[0];
  for (const candidate of legalActions) {
    const next = applyAction(state, candidate, false);
    let score = 0;
    if (next.winner !== null) score = next.winner === 'draw' ? 0 : next.winner === side ? 1e6 : -1e6;
    else {
      for (const piece of next.board) if (piece) score += (piece.side === side ? 1 : -1) * values[piece.kind];
      for (let s = 0; s < 2; s++) for (const kind of next.hands[s]) score += (s === side ? 1 : -1) * values[kind] * 0.8;
    }
    if (score > best) { best = score; action = candidate; }
  }
  return { action, info: { nodes: legalActions.length, completedDepth: 1 } };
}
