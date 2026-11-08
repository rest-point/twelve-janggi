import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction, legalActions, createPosition, isLegalAction } from '../src/engine.js';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';

test('opening probes cover all four legal choices for both starters and replies in the production boundary', async () => {
  for (const model of (await loadRegistry()).filter(m => m.id.startsWith('lab-opening-'))) {
    const client = new ModelProcess(model);
    try {
      assert.equal((await client.ready()).error, undefined);
      for (const first of [0, 1]) {
        const start = initialState(first), reply = applyAction(start, first === 0 ? { from: 5, to: 6 } : { from: 6, to: 5 }, false);
        for (const state of [start, reply]) {
          const before = structuredClone(state), actions = legalActions(state);
          const output = await client.think({ protocol: 'js-v1', ruleset: state.ruleset,
            requestId: `${model.id}-${first}-${state.ply}`, state, legalActions: actions, budgetMs: 60000, seed: 0, config: model.config }, 60000);
          assert.equal(output.error, undefined);
          assert.deepEqual(output.action, actions[model.config.openingIndex]);
          assert.equal(output.info.nodes, 0);
          assert.deepEqual(state, before);
        }
      }
      const board = Array(12).fill(null); board[2] = { side: 0, kind: 'king' }; board[11] = { side: 1, kind: 'king' };
      const state = createPosition({ board }), output = await client.think({ protocol: 'js-v1', ruleset: state.ruleset,
        requestId: model.id + '-off-book', state, legalActions: legalActions(state), budgetMs: 60000, seed: 0, config: model.config }, 60000);
      assert.equal(output.error, undefined);
      assert.ok(isLegalAction(state, output.action));
      assert.equal(applyAction(state, output.action, false).winner, 0);
      assert.equal(output.info.nodes, 800);
    } finally { client.close(); }
  }
});
