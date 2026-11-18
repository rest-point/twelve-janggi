import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, initialState, isLegalAction, legalActions } from '../src/engine.js';
import { loadRegistry, rng } from '../bench/common.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { openFullTablebase } from '../models/full-tablebase-v2.mjs';
import { DEFAULT_CONFIG, think } from '../models/tablebase-reply-mlp-v1.mjs';
import { ModelProcess } from '../server/model-process.mjs';

test('reply ranking and short-budget fallback preserve the full tablebase outcome on drawn boards', () => {
  const table = openFullTablebase(), random = rng(137);
  let checked = 0;
  try {
    for (let game = 0; game < 16; game++) {
      let state = initialState(game % 2);
      for (let ply = 0; ply < 40 && state.winner === null; ply++) {
        const legal = legalActions(state);
        const root = table.probe(new FastPosition(state));
        const drawn = legal.map(action => applyAction(state, action, false))
          .filter(child => child.winner === null && table.probe(new FastPosition(child)) === 1);
        if (root !== 1 || !drawn.length) break;
        const saved = structuredClone(state);
        for (const budgetMs of [0, 60000]) {
          const { action } = think({ state, legalActions: legal, budgetMs, seed: game });
          assert.ok(isLegalAction(state, action));
          const next = applyAction(state, action, false);
          if (next.winner === null) {
            const raw = table.probe(new FastPosition(next));
            assert.ok(raw === 1 || raw <= -256);
          } else assert.ok(next.winner === 'draw' || next.winner === state.turn);
        }
        assert.deepEqual(state, saved);
        state = drawn[Math.floor(random() * drawn.length)];
        checked++;
      }
    }
    assert.ok(checked >= 100);
  } finally { table.close(); }
});

test('reply ranking accepts legal custom positions outside the full tablebase', () => {
  const board = Array(12).fill(null);
  board[0] = { side: 0, kind: 'king' };
  board[11] = { side: 1, kind: 'king' };
  const state = createPosition({ board });
  const response = think({ state, legalActions: legalActions(state), budgetMs: 0 });
  assert.ok(isLegalAction(state, response.action));
});

test('registered reply ranking runs with declared assets in the restricted worker', async () => {
  const model = (await loadRegistry()).find(entry => entry.id === 'tablebase-reply-mlp-v1');
  assert.ok(model);
  assert.deepEqual(model.config, DEFAULT_CONFIG);
  const worker = new ModelProcess(model);
  try {
    assert.equal((await worker.ready()).error, undefined);
    for (const side of [0, 1]) {
      const state = initialState(side);
      const response = await worker.think({ protocol: 'js-v1', ruleset: state.ruleset, requestId: String(side),
        state, legalActions: legalActions(state), config: model.config, budgetMs: 1000, seed: 37 }, 3000);
      assert.equal(response.error, undefined);
      assert.ok(isLegalAction(state, response.action));
    }
  } finally { worker.close(); }
});
