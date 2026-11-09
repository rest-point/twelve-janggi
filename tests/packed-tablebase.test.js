import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, initialState, legalActions, positionKey } from '../src/engine.js';
import { FastPosition, decodeAction } from '../models/pvs-aspiration-rules-v1.mjs';
import { loadTablebase, probeTablebase, searchWithTablebase } from '../models/packed-tablebase-v1.mjs';
import { buildTablebase } from '../train/build-packed-tablebase.mjs';
import { analyze } from '../models/tablebase-minimax-reply-v1.mjs';

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

test('reply profiles prefer winning chances within a guaranteed draw over a refuted move', () => {
  const initial = initialState(), actions = legalActions(initial);
  const [safe, upside, trap] = actions;
  const table = new Map();
  const positions = [];
  for (const action of actions) {
    const child = applyAction(initial, action, false);
    const grandchildren = legalActions(child).map(reply => applyAction(child, reply, false));
    assert.ok(grandchildren.length >= 2 && grandchildren.every(state => state.winner === null));
    for (const [i, grandchild] of grandchildren.entries()) {
      // Supply synthetic WDL entries for this ranking test. Draws go through
      // the real referee history and all other replies stay distinguishable.
      if (action === safe || action === upside && i > 0) {
        positions.push(positionKey(grandchild), positionKey(grandchild));
      } else {
        const value = action !== upside && (action !== trap || i === 0) ? -1 : 1;
        table.set(new FastPosition(grandchild).key(), { value, distance: 1 });
      }
    }
  }
  const state = { ...initial, positions: [...positions, positionKey(initial)] };
  const before = structuredClone(state);
  const result = analyze({ state, legalActions: actions, budgetMs: 5000, config: { tablebaseMaxMs: 500 } }, table);
  assert.deepEqual(result.action, upside);
  assert.equal(result.source, 'reply-profile');
  assert.deepEqual(result.candidates.slice(0, 3).map(candidate => candidate.value), [0, 0, -1]);
  assert.equal(result.candidates[2].replies.losses, 1);
  assert.ok(result.candidates[2].replies.wins > 0);
  assert.deepEqual(state, before);
});
