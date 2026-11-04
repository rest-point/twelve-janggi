import test from 'node:test';
import assert from 'node:assert/strict';
import { think } from '../models/stockjang-v1.mjs';
import { applyAction, createPosition, initialState, isInCheck, isLegalAction, legalActions, positionKey } from '../src/engine.js';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';

const config = { maxDepth: 3, maxNodes: 200000, maxTimeMs: 55000, quiescenceDepth: 1 };
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);
  for (const [square, side, kind] of pieces) board[square] = { side, kind };
  return createPosition({ board, turn, hands });
}
function request(state, overrides = {}) {
  return { state, legalActions: legalActions(state), seed: 17, budgetMs: 60000, config, ...overrides };
}
function mirror(s) {
  return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn });
}
function forceWin(s, side, depth) {
  if (s.winner !== null) return s.winner === side;
  if (!depth) return false;
  const results = legalActions(s).map(a => forceWin(applyAction(s, a, false), side, depth - 1));
  return s.turn === side ? results.some(Boolean) : results.every(Boolean);
}
function repetitionFixture() {
  const state = fixture([[2, 0, 'bishop'], [3, 1, 'rook'], [4, 0, 'king'], [6, 1, 'king'], [8, 0, 'rook'], [9, 1, 'pawn'], [11, 1, 'bishop']], 0, [[], ['pawn']]);
  const drawAction = { from: 2, to: 7 };
  const repeatedKey = positionKey(applyAction(state, drawAction, false));
  return { state, drawAction, repeated: { ...state, positions: [repeatedKey, repeatedKey, ...state.positions] } };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('StockJang selects immediate try and checkmate for either color', () => {
  const positions = [
    fixture([[2, 0, 'king'], [11, 1, 'king']]),
    fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]),
  ];
  for (const original of positions) for (const state of [original, mirror(original)]) {
    const result = think(request(state));
    const next = applyAction(state, result.action, false);
    assert.equal(next.winner, state.turn);
    assert.equal(result.info.completedDepth, 1);
  }
});

test('StockJang finds a unique three-ply forced win verified with an exhaustive oracle', () => {
  const original = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  for (const state of [original, mirror(original)]) {
    const winning = legalActions(state).filter(a => forceWin(applyAction(state, a, false), state.turn, 2));
    assert.equal(winning.length, 1);
    assert.ok(legalActions(state).every(a => applyAction(state, a, false).winner !== state.turn));
    const result = think(request(state, { config: { ...config, quiescenceDepth: 0 } }));
    assert.deepEqual(result.action, winning[0]);
    assert.equal(forceWin(applyAction(state, result.action, false), state.turn, 2), true);
  }
});

test('StockJang answers check, handles hands and promotion, and never mutates its inputs', () => {
  const positions = [
    fixture([[4, 0, 'king'], [0, 0, 'bishop'], [8, 0, 'pawn'], [5, 1, 'rook'], [11, 1, 'king']], 0, [['pawn'], []]),
    fixture([[4, 0, 'king'], [11, 1, 'king'], [2, 0, 'pawn'], [7, 1, 'rook']]),
    fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'pawn', 'bishop'], []]),
  ];
  for (const original of positions) for (const state of [original, mirror(original)]) {
    const input = freeze(request(state));
    const before = structuredClone(input);
    const result = think(input);
    assert.equal(isLegalAction(state, result.action), true);
    assert.equal(isInCheck(applyAction(state, result.action, false), state.turn), false);
    if (result.action.drop) assert.notEqual(result.action.to % 4, state.turn === 0 ? 3 : 0);
    assert.deepEqual(input, before);
    for (const value of Object.values(result.info)) assert.ok(Number.isFinite(value) && value >= 0);
  }
});

test('repetition history changes the decision; cached and uncached searches agree', () => {
  const { state, repeated, drawAction } = repetitionFixture();
  for (const tableEntries of [0, 8192]) {
    const options = { ...config, tableEntries };
    const ordinary = think(request(state, { config: options }));
    const draw = think(request(repeated, { config: options }));
    assert.deepEqual(ordinary.action, { from: 8, to: 9 });
    assert.deepEqual(draw.action, drawAction);
    assert.equal(applyAction(repeated, draw.action, false).termination, 'repetition');
    // Calling another game/history between identical requests cannot leak cache.
    assert.deepEqual(think(request(state, { config: options })).action, ordinary.action);
  }
});

test('TT ordering and exact bounds preserve decisions on branching positions with cyclic history', () => {
  const { repeated } = repetitionFixture();
  for (const state of [initialState(0), initialState(1), repeated]) {
    const options = { ...config, maxDepth: 4, quiescenceDepth: 0 };
    const cached = think(request(state, { config: { ...options, tableEntries: 8192 } }));
    const uncached = think(request(state, { config: { ...options, tableEntries: 0 } }));
    assert.equal(cached.info.completedDepth, 4);
    assert.equal(uncached.info.completedDepth, 4);
    assert.deepEqual(cached.action, uncached.action);
  }
});

test('node interruption returns the last complete iteration and tiny time budgets return a legal fallback', () => {
  const state = initialState();
  const shallow = think(request(state, { config: { ...config, maxDepth: 1, quiescenceDepth: 0 } }));
  const interrupted = think(request(state, { config: { ...config, maxDepth: 8, quiescenceDepth: 0, maxNodes: shallow.info.nodes + 1 } }));
  assert.equal(interrupted.info.completedDepth, 1);
  assert.deepEqual(interrupted.action, shallow.action);
  assert.ok(interrupted.info.nodes <= shallow.info.nodes + 1);
  for (const budgetMs of [0, 1, 5]) {
    const result = think(request(state, { budgetMs }));
    assert.equal(isLegalAction(state, result.action), true);
    assert.equal(result.info.completedDepth, 0);
    assert.equal(result.info.nodes, 0);
  }
  const limited = think(request(state, { config: { ...config, maxNodes: 1 } }));
  assert.equal(isLegalAction(state, limited.action), true);
  assert.equal(limited.info.nodes, 1);
  assert.throws(() => think(request(state, { legalActions: [] })), /No legal actions/);
});

test('registered StockJang loads in the production permission boundary and reuses its Worker safely', async () => {
  const model = (await loadRegistry()).find(m => m.id === 'stockjang-v1');
  assert.ok(model);
  const client = new ModelProcess(model);
  try {
    assert.equal((await client.ready()).error, undefined);
    const { state, repeated, drawAction } = repetitionFixture();
    for (const [i, position] of [state, repeated, state].entries()) {
      const response = await client.think({ ...request(position), protocol: 'js-v1', ruleset: position.ruleset, requestId: `stockjang-test-${i}` }, 60000);
      assert.equal(response.error, undefined);
      assert.deepEqual(response.action, i === 1 ? drawAction : { from: 8, to: 9 });
      assert.equal(response.info.completedDepth, 3);
    }
  } finally { client.close(); }
});
