import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { loadRegistry } from '../bench/common.mjs';
import { initialState, isLegalAction, legalActions } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

const priorIds = ['random-v1', 'greedy-v1', 'minimax-v1', 'team-mcts-v1',
  'stockjang-v1', 'azero-v2', 'packed-gemm-puct-v2', 'tablebase-minimax-reply-v2'];
const sharedFiles = ['./azero-core.mjs', './azero-v2.bin',
  './full-tablebase-v2.mjs', './pvs-aspiration-rules-v1.mjs', './pvs-aspiration-v1.mjs', './dfpn-proof-v1.mjs',
  ...Array.from({ length: 8 }, (_, index) => `./full-tablebase/strict-v2-${index}.tjb`)];
const declaredFiles = version => [`./team-contender-search-${version}.mjs`, ...sharedFiles];
const previousRegistryHash = 'f3431a4fbc42154e76cfa2e75653a6cf9351a67e974e875cf483c09bf20a3a56';

test('team-contender registration preserves existing models and declares every worker dependency', async () => {
  const registry = await loadRegistry(), ids = registry.map(model => model.id);
  const sourceRegistry = JSON.parse(await readFile(new URL('../models/registry.json', import.meta.url), 'utf8'));
  const model = registry.find(candidate => candidate.id === 'team-contender-v2');
  assert.ok(model, 'Missing team-contender-v2');
  assert.equal(new Set(ids).size, ids.length);
  for (const id of priorIds) assert.ok(ids.includes(id), `Existing model ${id} was removed`);
  assert.equal(createHash('sha256').update(JSON.stringify(sourceRegistry.filter(candidate => priorIds.includes(candidate.id)))).digest('hex'),
    previousRegistryHash, 'Existing model registrations changed');
  assert.equal(model.name, 'Team Repetition-Safe Full Tablebase Search');
  assert.equal(model.version, '2.0.0');
  assert.equal(model.protocol, 'js-v1');
  assert.equal(model.ruleset, 'twelve-janggi-strict-v2');
  assert.equal(model.entry, './team-contender-v2.mjs');
  assert.deepEqual(model.files, declaredFiles('v2'));
  assert.equal(model.config.maxTimeMs, 2000);
  assert.equal(model.config.tablebaseMaxMs, 2000);
  assert.equal(model.config.rootProofNodes, 1000);
  for (const file of [model.entry, ...model.files]) {
    assert.ok(model.digests[file], `Missing digest for ${file}`);
    await access(new URL(`../models/${file.slice(2)}`, import.meta.url));
  }
});

test('team contenders return legal moves for both starters and safely reuse production Workers', async () => {
  const registry = await loadRegistry();
  for (const id of ['team-contender-v2']) {
    const model = registry.find(candidate => candidate.id === id);
    const client = new ModelProcess(model);
    try {
      assert.equal((await client.ready()).error, undefined);
      for (const [index, turn] of [0, 1, 0].entries()) {
        const state = initialState(turn);
        const request = { protocol: 'js-v1', requestId: `${id}-integration-${index}`, ruleset: state.ruleset,
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
  }
});
