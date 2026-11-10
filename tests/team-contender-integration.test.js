import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { loadRegistry } from '../bench/common.mjs';
import { initialState, isLegalAction, legalActions } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

const priorIds = ['random-v1', 'greedy-v1', 'minimax-v1', 'team-greedy-v1', 'team-minimax-v1', 'team-mcts-v1',
  'stockjang-v1', 'azero-v1', 'azero-v2', 'packed-gemm-puct-v2', 'tablebase-minimax-reply-v2', 'lab-neural-v2'];
const declaredFiles = ['./team-contender-search-v1.mjs', './azero-core.mjs', './azero-v2.bin',
  './full-tablebase-v2.mjs', './pvs-aspiration-rules-v1.mjs', './pvs-aspiration-v1.mjs', './dfpn-proof-v1.mjs',
  ...Array.from({ length: 8 }, (_, index) => `./full-tablebase/strict-v2-${index}.tjb`)];
const previousRegistryHash = '51ac51bb11d08f3a1dd9c844321da1fa9cf7abed46a6f3efe1719cd557411789';

test('team-contender registration preserves existing models and declares every worker dependency', async () => {
  const registry = await loadRegistry(), ids = registry.map(model => model.id);
  const sourceRegistry = JSON.parse(await readFile(new URL('../models/registry.json', import.meta.url), 'utf8'));
  const model = registry.find(candidate => candidate.id === 'team-contender-v1');
  assert.ok(model, 'Missing team-contender-v1');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of priorIds) assert.ok(ids.includes(id), `Existing model ${id} was removed`);
  assert.equal(ids.length, priorIds.length + 1);
  assert.equal(createHash('sha256').update(JSON.stringify(sourceRegistry.filter(candidate => candidate.id !== 'team-contender-v1'))).digest('hex'),
    previousRegistryHash, 'Existing model registrations changed');
  assert.equal(model.name, 'Team Repetition-Aware Tablebase Search');
  assert.equal(model.version, '1.0.0');
  assert.equal(model.protocol, 'js-v1');
  assert.equal(model.ruleset, 'twelve-janggi-strict-v2');
  assert.equal(model.entry, './team-contender-v1.mjs');
  assert.deepEqual(model.files, declaredFiles);
  assert.equal(model.config.maxTimeMs, 360);
  assert.equal(model.config.tablebaseMaxMs, 32);
  assert.equal(model.config.rootProofNodes, 1000);
  for (const file of [model.entry, ...model.files]) {
    assert.ok(model.digests[file], `Missing digest for ${file}`);
    await access(new URL(`../models/${file.slice(2)}`, import.meta.url));
  }
});

test('team contender returns legal moves for both starters and safely reuses its production Worker', async () => {
  const model = (await loadRegistry()).find(candidate => candidate.id === 'team-contender-v1');
  assert.ok(model, 'Missing team-contender-v1');
  const client = new ModelProcess(model);
  try {
    assert.equal((await client.ready()).error, undefined);
    for (const [index, turn] of [0, 1, 0].entries()) {
      const state = initialState(turn);
      const request = { protocol: 'js-v1', requestId: `team-contender-integration-${index}`, ruleset: state.ruleset,
        state, legalActions: legalActions(state), budgetMs: 1000, seed: 71, config: model.config };
      const before = structuredClone(request);
      const response = await client.think(request, 3000);
      assert.equal(response.error, undefined);
      assert.equal(isLegalAction(state, response.action), true);
      assert.ok(Number.isFinite(response.info.nodes) && response.info.nodes >= 0);
      assert.ok(Number.isFinite(response.info.completedDepth) && response.info.completedDepth >= 0);
      assert.ok(Number.isFinite(response.info.searchMs) && response.info.searchMs >= 0 && response.info.searchMs < 2500);
      assert.deepEqual(request, before);
      // A repeated state confirms the same Worker remains healthy. Its exact
      // move may differ if the time cap allows a different completed depth.
    }
  } finally { client.close(); }
});
