import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, legalActions } from '../src/engine.js';
import { actionCode } from '../models/pvs-aspiration-rules-v1.mjs';
import { searchBatch } from '../models/packed-puct-search-v2.mjs';

test('packed learner masks moves that concede an immediate win and records only completed visits', () => {
  const state = createPosition({
    board: [null, { side: 1, kind: 'king' }, null, { side: 1, kind: 'rook' }, null, null, null,
      { side: 0, kind: 'bishop' }, { side: 0, kind: 'rook' }, { side: 0, kind: 'king' },
      null, { side: 1, kind: 'bishop' }],
    hands: [['pawn', 'pawn'], []], turn: 0,
  });
  const actions = legalActions(state);
  const safe = actions.filter(action => {
    const child = applyAction(state, action, false);
    return !legalActions(child).some(reply => applyAction(child, reply, false).winner === child.turn);
  });
  assert.deepEqual(safe, [{ from: 8, to: 4 }]);
  const before = structuredClone(state);
  const result = searchBatch({ state, legalActions: actions, config: {
    simulations: 12, rootProofNodes: 0, leafProofNodes: 0, maxTimeMs: 5000,
  } }, requests => requests.map(({ actions }) => ({
    value: 0, prior: new Float64Array(actions.length).fill(1 / actions.length),
  })));
  assert.deepEqual(result.action, safe[0]);
  assert.deepEqual(result.root.actions, safe.map(actionCode));
  assert.equal(result.root.visits.reduce((a, b) => a + b, 0), result.diagnostics.completedSimulations);
  assert.equal(result.diagnostics.virtualReservations, 0);
  assert.deepEqual(state, before);
});
