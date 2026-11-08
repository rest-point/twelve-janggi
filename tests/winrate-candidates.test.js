import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadRegistry } from '../bench/common.mjs';
import { initialState, createPosition, legalActions, isLegalAction, applyAction } from '../src/engine.js';
import { ModelProcess } from '../server/model-process.mjs';

test('lab search candidates load with declared files, preserve referee input, and return legal moves for both starters', async () => {
  const candidates = (await loadRegistry()).filter(m => m.id.startsWith('lab-'));
  for (const id of ['lab-stockjang-v1', 'lab-azero-v1', 'lab-azero-v2']) assert.ok(candidates.some(m => m.id === id));
  for (const model of candidates) {
    const process = new ModelProcess(model);
    try {
      assert.equal((await process.ready()).error, undefined, model.id + ' load');
      for (const turn of [0, 1]) {
        const state = initialState(turn);
        const request = { protocol: 'js-v1', ruleset: state.ruleset, requestId: `${model.id}-${turn}`,
          state, legalActions: legalActions(state), budgetMs: 60000, seed: 20261108, config: model.config };
        const before = structuredClone(request);
        const reply = await process.think(request, 60000);
        assert.equal(reply.error, undefined, model.id + ' response');
        assert.ok(isLegalAction(state, reply.action), model.id + ' legality');
        assert.deepEqual(request, before);
        assert.ok(Number.isFinite(reply.info.searchMs) && reply.info.searchMs >= 0);
      }
    } finally { process.close(); }
  }
});

test('lab candidates find immediate safe king entries for both colours without mutating history', async () => {
  for (const model of (await loadRegistry()).filter(m => m.id.startsWith('lab-'))) {
    const { think } = await import(pathToFileURL(model.entryPath));
    for (const turn of [0, 1]) {
      const board = Array(12).fill(null);
      board[turn === 0 ? 2 : 0] = { side: 0, kind: 'king' };
      board[turn === 0 ? 11 : 9] = { side: 1, kind: 'king' };
      const state = createPosition({ board, turn });
      const before = structuredClone(state);
      const response = think({ state, legalActions: legalActions(state), budgetMs: 60000, seed: 0, config: model.config });
      assert.equal(applyAction(state, response.action, false).winner, turn, model.id);
      assert.deepEqual(state, before);
    }
  }
});
