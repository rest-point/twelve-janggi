import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../bench/common.mjs';
import { LAYOUT } from '../models/azero-core.mjs';
import { initialState, legalActions, isLegalAction } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

test('azero registration preserves all existing models and declares a complete finite weight asset', async () => {
  const registry = await loadRegistry();
  for (const id of ['random-v1', 'greedy-v1', 'minimax-v1', 'team-greedy-v1', 'team-minimax-v1', 'team-mcts-v1', 'stockjang-v1', 'azero-v1', 'azero-v2']) {
    assert.ok(registry.some(m => m.id === id), `Missing ${id}`);
  }
  for (const id of ['azero-v1', 'azero-v2']) {
    const model = registry.find(m => m.id === id);
    assert.deepEqual(model.files, ['./azero-core.mjs', `./${id}.bin`]);
    const bytes = await readFile(new URL(`../models/${id}.bin`, import.meta.url));
    assert.equal(bytes.byteLength, LAYOUT.size * Float32Array.BYTES_PER_ELEMENT);
    const weights = new Float32Array(bytes.buffer, bytes.byteOffset, LAYOUT.size);
    assert.ok(weights.every(Number.isFinite));
    assert.ok(weights.some(value => value !== 0));
  }
});

test('azero answers both starters in the production permission boundary and safely reuses its Worker', async () => {
  const registry = await loadRegistry();
  for (const id of ['azero-v1', 'azero-v2']) {
    const model = registry.find(m => m.id === id);
    const client = new ModelProcess(model);
    try {
      assert.equal((await client.ready()).error, undefined);
      let first;
      for (const [i, turn] of [0, 1, 0].entries()) {
        const state = initialState(turn);
        const request = { protocol: 'js-v1', requestId: `${id}-integration-${i}`, ruleset: state.ruleset,
          state, legalActions: legalActions(state), budgetMs: 60000, seed: 17, config: model.config };
        const before = structuredClone(request);
        const response = await client.think(request, 60000);
        assert.equal(response.error, undefined);
        assert.equal(isLegalAction(state, response.action), true);
        assert.equal(response.info.nodes, model.config.sims);
        assert.ok(Number.isFinite(response.info.searchMs) && response.info.searchMs >= 0);
        assert.deepEqual(request, before);
        if (i === 0) first = response.action;
        if (i === 2) assert.deepEqual(response.action, first);
      }
    } finally { client.close(); }
  }
});
