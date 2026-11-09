import test from 'node:test';
import assert from 'node:assert/strict';
import { think, evaluatePosition } from '../models/pvs-aspiration-v1.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { applyAction, createPosition, initialState, isLegalAction, legalActions, positionKey } from '../src/engine.js';

const config = { maxDepth: 3, maxNodes: 500000, maxTimeMs: 55000, quiescenceDepth: 0, tableEntries: 8192, aspirationWindow: 1 };
const request = (state, overrides = {}) => ({ state, legalActions: legalActions(state), budgetMs: 60000, seed: 17, config, ...overrides });
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);
  for (const [square, side, kind] of pieces) board[square] = { side, kind };
  return createPosition({ board, hands, turn });
}
function mirror(s) {
  return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn });
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Exhaustive minimax uses the official referee for transitions and termination,
// independently of compact rules, alpha-beta, PVS, aspiration and caches.
function oracle(s, depth, ply = 0) {
  if (s.winner !== null) return s.winner === 'draw' ? 0 : s.winner === s.turn ? 100000 - ply : -100000 + ply;
  if (!depth) return evaluatePosition(new FastPosition(s));
  return Math.max(...legalActions(s).map(a => -oracle(applyAction(s, a, false), depth - 1, ply + 1)));
}

test('PVS selects a minimax-optimal action with aspiration and TT enabled or disabled', () => {
  const states = [initialState(0), initialState(1)];
  let state = initialState(), seed = 981207;
  for (let i = 0; states.length < 200; i++) {
    const moves = legalActions(state).filter(a => applyAction(state, a, false).winner === null);
    if (!moves.length || state.ply >= 80) { state = initialState(i % 2); continue; }
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    state = applyAction(state, moves[(seed >>> 0) % moves.length], false);
    states.push(state);
  }
  for (const s of states) {
    const values = legalActions(s).map(action => ({ action, score: -oracle(applyAction(s, action, false), 2, 1) }));
    const best = Math.max(...values.map(v => v.score));
    for (const tableEntries of [0, 8192]) for (const aspirationWindow of [1, 200000]) {
      const result = think(request(s, { config: { ...config, tableEntries, aspirationWindow } }));
      const selected = values.find(v => JSON.stringify(v.action) === JSON.stringify(result.action));
      assert.ok(selected);
      assert.equal(selected.score, best, JSON.stringify({ result, best, tableEntries, aspirationWindow }));
      assert.ok(result.info.completedDepth >= 3 || best >= 99997 || best <= -99997);
    }
  }
});

test('PVS prefers immediate try/mate and the unique three-ply forced win for both colors', () => {
  const immediate = [fixture([[2, 0, 'king'], [11, 1, 'king']]), fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']])];
  for (const original of immediate) for (const s of [original, mirror(original)]) {
    assert.equal(applyAction(s, think(request(s)).action, false).winner, s.turn);
  }
  const forced = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  for (const s of [forced, mirror(forced)]) {
    const winners = legalActions(s).filter(a => -oracle(applyAction(s, a, false), 2, 1) >= 99997);
    assert.equal(winners.length, 1);
    assert.deepEqual(think(request(s)).action, winners[0]);
    assert.deepEqual(think(request(s, { config: { ...config, quiescenceDepth: 5 } })).action, winners[0]);
  }
});

function repetitionFixture() {
  const state = fixture([[2, 0, 'bishop'], [3, 1, 'rook'], [4, 0, 'king'], [6, 1, 'king'], [8, 0, 'rook'], [9, 1, 'pawn'], [11, 1, 'bishop']], 0, [[], ['pawn']]);
  const drawAction = { from: 2, to: 7 }, key = positionKey(applyAction(state, drawAction, false));
  return { state, drawAction, repeated: { ...state, positions: [key, key, ...state.positions] } };
}
test('PVS separates identical boards with different histories, reuses no game caches, and accepts long games', () => {
  const { state, repeated, drawAction } = repetitionFixture();
  for (const tableEntries of [0, 8192]) {
    const options = { config: { ...config, tableEntries } };
    const first = think(request(state, options));
    assert.deepEqual(first.action, { from: 8, to: 9 });
    assert.deepEqual(think(request(repeated, options)).action, drawAction);
    assert.deepEqual(think(request({ ...state, ply: 400 }, options)).action, first.action);
  }
});

test('budget interruption retains the last completed iteration and input objects remain untouched', () => {
  const state = initialState();
  const input = freeze(request(state)), before = structuredClone(input);
  const result = think(input);
  assert.equal(isLegalAction(state, result.action), true);
  assert.deepEqual(input, before);
  const shallowConfig = { ...config, maxDepth: 1 };
  const shallow = think(request(state, { config: shallowConfig }));
  const interrupted = think(request(state, { config: { ...config, maxDepth: 8, maxNodes: shallow.info.nodes + 1 } }));
  assert.equal(interrupted.info.completedDepth, 1);
  assert.deepEqual(interrupted.action, shallow.action);
  assert.equal(interrupted.info.nodes, shallow.info.nodes + 1);
  for (const budgetMs of [0, 1, 5]) {
    const r = think(request(state, { budgetMs }));
    assert.equal(isLegalAction(state, r.action), true);
    assert.equal(r.info.nodes, 0);
    assert.equal(r.info.completedDepth, 0);
  }
  assert.throws(() => think(request(state, { legalActions: [] })), /No legal actions/);
});
