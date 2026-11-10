import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry } from '../bench/common.mjs';
import { initialState, legalActions, isLegalAction } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

test('published lab-neural-v2 registration preserves its source manifest and original budget', async () => {
  const registry = await loadRegistry();
  const model = registry.find(candidate => candidate.id === 'lab-neural-v2');
  assert.ok(model, 'Missing lab-neural-v2 benchmark baseline');
  assert.equal(model.protocol, 'js-v1');
  assert.equal(model.ruleset, 'twelve-janggi-strict-v2');
  assert.equal(model.entry, './lab-neural-v2.mjs');
  assert.deepEqual(model.files, ['./lab-neural-search-v1.mjs', './azero-core.mjs', './azero-v2.bin']);
  assert.deepEqual(model.config, { maxDepth: 10, maxNodes: 16000, maxTimeMs: 2000, cacheEntries: 3000, drawBias: 0.1 });
  assert.equal(model.author, 'winrate-lab');
});

test('published neural baseline returns a legal move for either starter without mutating input', async () => {
  const model = (await loadRegistry()).find(candidate => candidate.id === 'lab-neural-v2');
  assert.ok(model, 'Missing lab-neural-v2 benchmark baseline');
  const client = new ModelProcess(model);
  try {
    assert.equal((await client.ready()).error, undefined);
    for (const turn of [0, 1]) {
      const state = initialState(turn);
      const request = { protocol: 'js-v1', requestId: `lab-neural-v2-${turn}`, ruleset: state.ruleset,
        state, legalActions: legalActions(state), budgetMs: 60000, seed: 17, config: model.config };
      const before = structuredClone(request);
      const response = await client.think(request, 60000);
      assert.equal(response.error, undefined);
      assert.equal(isLegalAction(state, response.action), true);
      assert.ok(Number.isFinite(response.info.nodes));
      assert.ok(Number.isFinite(response.info.searchMs) && response.info.searchMs >= 0);
      assert.deepEqual(request, before);
    }
  } finally { client.close(); }
});
