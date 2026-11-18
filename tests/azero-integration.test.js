import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadRegistry } from '../bench/common.mjs';
import { LAYOUT } from '../models/azero-core.mjs';
import { initialState, legalActions, isLegalAction } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

test('azero-v2 declares a complete finite weight asset', async () => {
  const registry = await loadRegistry();
  const model = registry.find(m => m.id === 'azero-v2');
  assert.ok(model);
  assert.deepEqual(model.files, ['./azero-core.mjs', './azero-v2.bin']);
  const bytes = await readFile(new URL('../models/azero-v2.bin', import.meta.url));
  assert.equal(bytes.byteLength, LAYOUT.size * Float32Array.BYTES_PER_ELEMENT);
  const weights = new Float32Array(bytes.buffer, bytes.byteOffset, LAYOUT.size);
  assert.ok(weights.every(Number.isFinite));
  assert.ok(weights.some(value => value !== 0));
});

test('azero answers both starters in the production permission boundary and safely reuses its Worker', async () => {
  const registry = await loadRegistry();
  const model = registry.find(m => m.id === 'azero-v2');
  const client = new ModelProcess(model);
  try {
    assert.equal((await client.ready()).error, undefined);
    let first;
    for (const [i, turn] of [0, 1, 0].entries()) {
      const state = initialState(turn);
      const request = { protocol: 'js-v1', requestId: `${model.id}-integration-${i}`, ruleset: state.ruleset,
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
});
