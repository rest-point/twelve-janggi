import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, initialState, legalActions } from '../src/engine.js';
import { FastPosition, decodeAction } from '../models/pvs-aspiration-rules-v1.mjs';
import { loadTablebase, probeTablebase, searchWithTablebase } from '../models/packed-tablebase-v1.mjs';
import { buildTablebase } from '../train/build-packed-tablebase.mjs';

test('tablebase leaves truncated positions unknown and preserves immediate wins', () => {
  const frontier = buildTablebase([initialState()], 1);
  assert.equal(frontier.counts.unknown, 1);
  assert.ok(frontier.counts.frontierEdges > 0);
  const board = Array(12).fill(null);
  board[2] = { side: 0, kind: 'king' };
  board[11] = { side: 1, kind: 'king' };
  const state = createPosition({ board });
  const table = loadTablebase(buildTablebase([state], 32).bytes);
  const position = new FastPosition(state);
  const entry = probeTablebase(table, position);
  assert.equal(entry.value, 1);
  assert.equal(entry.distance, 1);
  const action = decodeAction(entry.move);
  const child = applyAction(state, action, false);
  assert.equal(child.winner, state.turn);
  position.counts.set(position.key(), 2);
  assert.equal(probeTablebase(table, position), entry);
  position.counts.set(new FastPosition(child).key(), 2);
  assert.equal(probeTablebase(table, position), null);
  const result = searchWithTablebase({ state, legalActions: legalActions(state), budgetMs: 1000 },
    () => assert.fail('Proof hit must bypass inference'), table);
  assert.deepEqual(result.action, action);
  assert.deepEqual(result.tablebase, { direct: true, distance: 1 });
});
