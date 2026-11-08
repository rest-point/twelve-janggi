import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, createPosition, legalActions, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { fromEngine } from '../models/azero-core.mjs';
import { analyze, evaluatePosition, MATE } from '../models/lab-fast-search-v1.mjs';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';
const request = (state, config = {}) => ({ state, legalActions: legalActions(state), budgetMs: 60000, seed: 0, config });

function exhaustive(state, depth, rootPly) {
  if (state.winner !== null) return state.winner === 'draw' ? 0 : (state.winner === state.turn ? 1 : -1) * (MATE - (state.ply - rootPly));
  if (!depth) return evaluatePosition(fromEngine(state));
  const best = Math.max(...legalActions(state).map(a => -exhaustive(applyAction(state, a, false), depth - 1, rootPly)));
  return best === 0 ? 0 : best;
}

test('compact alpha-beta matches independent referee-tree minimax, with and without history-aware score caching', () => {
  const initial = initialState(), middle = applyAction(applyAction(initial, { from: 5, to: 6 }, false), { from: 11, to: 6 }, false);
  for (const state of [initial, initialState(1), middle]) {
    const before = structuredClone(state), value = exhaustive(state, 3, state.ply);
    for (const tableEntries of [0, 16384]) {
      const out = analyze(request(state, { maxDepth: 3, maxNodes: 4000000, maxTimeMs: 15000, quiescenceDepth: 0, tableEntries }));
      assert.equal(out.info.completedDepth, 3);
      assert.equal(out.score, value);
      const selected = -exhaustive(applyAction(state, out.action, false), 2, state.ply);
      assert.equal(selected === 0 ? 0 : selected, value);
      assert.deepEqual(state, before);
    }
  }
});

test('compact search respects repetition counts and retains legal output under tiny budgets and late human plies', () => {
  const state = initialState();
  state.positions.push(...legalActions(state).flatMap(a => { const k = positionKey(applyAction(state, a, false)); return [k, k]; }));
  const before = structuredClone(state), out = analyze(request(state, { maxDepth: 3, maxTimeMs: 1000 }));
  assert.equal(out.score, 0); assert.deepEqual(state, before);
  assert.equal(applyAction(state, out.action, false).winner, 'draw');
  const late = { ...initialState(), ply: 300 };
  const response = analyze({ ...request(late), budgetMs: 1 });
  assert.ok(isLegalAction(late, response.action));
});

test('compact search finds safe king entry for either side and loads in the production permission boundary', async () => {
  for (const turn of [0, 1]) {
    const board = Array(12).fill(null); board[turn === 0 ? 2 : 0] = { side: 0, kind: 'king' }; board[turn === 0 ? 11 : 9] = { side: 1, kind: 'king' };
    const state = createPosition({ board, turn });
    assert.equal(applyAction(state, analyze(request(state)).action, false).winner, turn);
  }
  const model = (await loadRegistry()).find(m => m.id === 'lab-fast-search-v1'), client = new ModelProcess(model);
  try {
    assert.equal((await client.ready()).error, undefined);
    for (const turn of [0, 1]) {
      const state = initialState(turn), response = await client.think({ ...request(state, model.config),
        protocol: 'js-v1', ruleset: state.ruleset, requestId: 'fast-' + turn }, 60000);
      assert.equal(response.error, undefined); assert.ok(isLegalAction(state, response.action));
    }
  } finally { client.close(); }
});
