import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, initialState, legalActions } from '../src/engine.js';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { openFullTablebase } from '../models/full-tablebase-v2.mjs';
import { analyze, think } from '../models/tablebase-minimax-reply-v2.mjs';
import { FEATURES, createPracticalRanker, drawOptions } from '../models/tablebase-practical-ranker-v1.mjs';

test('full tablebase avoids both first blunders reproduced from the v1 losses', () => {
  const fixtures = [
    { first: 0, prefix: [{ from: 5, to: 6 }, { from: 11, to: 6 }, { from: 0, to: 5 }], blunder: { drop: 'pawn', to: 2 } },
    { first: 1, prefix: [{ from: 7, to: 10 }, { from: 8, to: 9 }, { from: 10, to: 7 }, { from: 5, to: 6 },
      { from: 11, to: 6 }, { from: 0, to: 5 }, { from: 6, to: 9 }, { from: 4, to: 9 }, { drop: 'rook', to: 6 },
      { drop: 'bishop', to: 1 }, { drop: 'pawn', to: 10 }, { from: 9, to: 4 }], blunder: { from: 7, to: 11 } },
  ];
  const table = openFullTablebase();
  try {
    for (const { first, prefix, blunder } of fixtures) {
      assert.equal(table.probe(new FastPosition(initialState(first))), 1);
      const state = prefix.reduce((position, action) => applyAction(position, action, false), initialState(first));
      const blunderValue = table.probe(new FastPosition(applyAction(state, blunder, false)));
      assert.ok(blunderValue >= 256, 'the opponent wins after the old move');
      const result = think({ state, legalActions: legalActions(state), budgetMs: 1000,
        config: { maxDepth: 1, maxTimeMs: 360, tablebaseMaxMs: 32 } });
      const child = applyAction(state, result.action, false), value = table.probe(new FastPosition(child));
      assert.ok(value === 1 || value <= -256 || child.winner === 'draw', 'the new move preserves a draw or better');
    }
  } finally { table.close(); }
});

test('nonstandard material falls back to a legal PVS move', () => {
  const board = Array(12).fill(null);
  board[0] = { side: 0, kind: 'king' };
  board[11] = { side: 1, kind: 'king' };
  const state = createPosition({ board });
  const legal = legalActions(state);
  const result = analyze({ state, legalActions: legal, budgetMs: 1000, config: { maxDepth: 2 } });
  assert.equal(result.source, 'pvs');
  assert.ok(legal.some(action => action.from === result.action.from && action.to === result.action.to));
});

test('learned practical ranker can reorder only draw-preserving moves', () => {
  const table = openFullTablebase();
  try {
    const actions = [{ from: 5, to: 6 }, { from: 11, to: 6 }, { from: 0, to: 5 }];
    const state = actions.reduce((position, action) => applyAction(position, action, false), initialState());
    const legal = legalActions(state), options = drawOptions(state, legal, table);
    assert.ok(options.length > 0 && options.length < legal.length);
    assert.ok(options.every(option => option.features.length === FEATURES.length && option.features.every(Number.isFinite)));
    const zeros = FEATURES.map(() => 0), ones = FEATURES.map(() => 1);
    const ranker = createPracticalRanker({ format: 'strict-v2-draw-ranker-v1', features: FEATURES,
      mean: zeros, scale: ones, hidden: [ones], bias: [0], output: [10] }, table, think);
    const request = { state, legalActions: legal, budgetMs: 1000, config: { maxTimeMs: 360 } };
    const result = ranker(request);
    assert.ok(options.some(option => JSON.stringify(option.action) === JSON.stringify(result.action)));
    const next = applyAction(state, result.action, false);
    assert.ok(next.winner === 'draw' || table.probe(new FastPosition(next)) === 1);
  } finally { table.close(); }
});
