import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, legalActions, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { fromEngine } from '../models/azero-core.mjs';
import { analyze, neuralEvaluation, MATE } from '../models/lab-neural-search-v1.mjs';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';
function exhaustive(s, depth, rootPly) {
  if (s.winner !== null) return s.winner === 'draw' ? 0 : (s.winner === s.turn ? 1 : -1) * (MATE - s.ply + rootPly);
  if (!depth) return neuralEvaluation(fromEngine(s), s.positions.filter(k => k === positionKey(s)).length);
  const best = Math.max(...legalActions(s).map(a => -exhaustive(applyAction(s, a, false), depth - 1, rootPly)));
  return best === 0 ? 0 : best;
}
test('neural alpha-beta equals an independent referee tree and never merges history-dependent terminal scores', () => {
  for (const state of [initialState(), initialState(1)]) {
    const before = structuredClone(state), value = exhaustive(state, 3, state.ply);
    for (const cacheEntries of [0, 3000]) {
      const r = analyze({ state, legalActions: legalActions(state), budgetMs: 60000,
        config: { maxDepth: 3, maxNodes: 100000, maxTimeMs: 30000, cacheEntries } });
      assert.equal(r.info.completedDepth, 3); assert.equal(r.score, value);
      const selected = -exhaustive(applyAction(state, r.action, false), 2, state.ply);
      assert.equal(selected === 0 ? 0 : selected, value); assert.deepEqual(state, before);
    }
  }
  const state = initialState(); state.positions.push(...legalActions(state).flatMap(a => {
    const key = positionKey(applyAction(state, a, false)); return [key, key];
  }));
  const r = analyze({ state, legalActions: legalActions(state), budgetMs: 60000, config: { maxDepth: 2, maxTimeMs: 5000, drawBias: 0.1 } });
  assert.equal(r.score, -1000); assert.equal(applyAction(state, r.action, false).winner, 'draw');
});

test('neural candidates load in real permission workers, preserve inputs and return valid moves for both starters', async () => {
  for (const model of (await loadRegistry()).filter(m => /^lab-neural-v/.test(m.id))) {
    const worker = new ModelProcess(model);
    try {
      assert.equal((await worker.ready()).error, undefined);
      for (const turn of [0, 1]) {
        const state = initialState(turn), before = structuredClone(state);
        const reply = await worker.think({ protocol: 'js-v1', ruleset: state.ruleset, requestId: model.id + '-' + turn,
          state, legalActions: legalActions(state), budgetMs: 60000, seed: 0, config: model.config }, 60000);
        assert.equal(reply.error, undefined); assert.ok(isLegalAction(state, reply.action)); assert.deepEqual(state, before);
      }
    } finally { worker.close(); }
  }
});
