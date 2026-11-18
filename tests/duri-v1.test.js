import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosition, initialState, legalActions, isLegalAction } from '../src/engine.js';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';

test('Duri runs in the restricted worker with only v1 weights and returns legal moves', async () => {
  const model = (await loadRegistry()).find(m => m.id === 'duri-v1');
  assert.ok(model, 'Duri must be registered');
  assert.ok(model.files.includes('./azero-v1.bin'));
  assert.ok(!model.files.some(file => file.includes('azero-v2')));
  const worker = new ModelProcess(model);
  try {
    assert.equal((await worker.ready()).error, undefined);
    for (const turn of [0, 1]) {
      const state = initialState(turn);
      const result = await worker.think({ state, legalActions: legalActions(state), budgetMs: 5000, config: { sims: 50, maxNodes: 51 }, protocol: 'js-v1', ruleset: state.ruleset, requestId: `duri-${turn}` }, 5000);
      assert.equal(result.error, undefined);
      assert.ok(isLegalAction(state, result.action));
    }
  } finally { worker.close(); }
});

test('Duri blocks the unique immediate winning threat even with minimal search', async () => {
  const { think } = await import('../models/duri-v1.mjs');
  const state = createPosition({ board: [
    { side: 0, kind: 'bishop' }, { side: 1, kind: 'king' }, null, null,
    null, null, { side: 0, kind: 'rook' }, { side: 1, kind: 'rook' },
    { side: 0, kind: 'king' }, null, { side: 0, kind: 'pawn' }, { side: 1, kind: 'bishop' },
  ], hands: [['pawn'], []], turn: 0 });
  const input = { state, legalActions: legalActions(state), budgetMs: 2000, config: { sims: 1, maxNodes: 8 } };
  const original = structuredClone(input);
  assert.deepEqual(think(input).action, { from: 0, to: 5 });
  assert.deepEqual(input, original);
});
