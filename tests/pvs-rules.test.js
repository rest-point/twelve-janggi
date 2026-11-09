import test from 'node:test';
import assert from 'node:assert/strict';
import { FastPosition, MASKS, actionCode, decodeAction } from '../models/pvs-aspiration-rules-v1.mjs';
import { adjudicateState, applyAction, createPosition, initialState, isInCheck, legalActions, positionKey, RULESET, validatePosition } from '../src/engine.js';

const KINDS = ['', 'king', 'rook', 'bishop', 'pawn', 'hen'];
const HANDS = ['rook', 'bishop', 'pawn'];
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);
  for (const [square, side, kind] of pieces) board[square] = { side, kind };
  return createPosition({ board, turn, hands });
}
function mirror(state) {
  return createPosition({ board: [...state.board].reverse().map(piece => piece ? { side: 1 - piece.side, kind: piece.kind } : null), hands: [state.hands[1], state.hands[0]], turn: 1 - state.turn });
}
function expectedKey(state) {
  const board = state.board.map(piece => piece ? piece.side * 8 + KINDS.indexOf(piece.kind) : 0);
  const hands = Array(6).fill(0);
  for (let side = 0; side < 2; side++) for (const kind of state.hands[side]) hands[side * 3 + HANDS.indexOf(kind)]++;
  return String.fromCharCode(...board, ...hands, state.turn);
}
function checkState(fast, official) {
  assert.equal(fast.key(), expectedKey(official));
  assert.equal(fast.turn, official.turn);
  assert.equal(fast.inCheck(0), isInCheck(official, 0));
  assert.equal(fast.inCheck(1), isInCheck(official, 1));
  assert.equal(fast.counts.get(fast.key()) || 0, official.positions.filter(key => key === positionKey(official)).length);
}
function checkChildren(state) {
  const before = structuredClone(state), fast = new FastPosition(state);
  const key = fast.key(), counts = new Map(fast.counts);
  const actions = fast.actions();
  assert.equal(fast.winner(actions), state.winner);
  assert.deepEqual(actions.map(decodeAction), legalActions(state));
  checkState(fast, state);
  for (const move of actions) {
    assert.equal(actionCode(decodeAction(move)), move);
    const undo = fast.make(move), child = applyAction(state, decodeAction(move), false);
    const nextActions = fast.actions();
    checkState(fast, child);
    assert.equal(fast.winner(nextActions), child.winner);
    if (child.winner === null) assert.deepEqual(nextActions.map(decodeAction), legalActions(child));
    fast.unmake(undo);
    assert.equal(fast.key(), key);
    assert.deepEqual(fast.counts, counts);
    checkState(fast, state);
  }
  assert.deepEqual(state, before);
}

test('compact strict-v2 rules match every child of 2000 reachable positions', () => {
  let seed = 20261106, state = initialState(), games = 0;
  function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
  for (let i = 0; i < 2000; i++) {
    if (state.winner !== null || state.ply >= 160) state = initialState(++games % 2);
    checkChildren(state);
    const actions = legalActions(state);
    state = applyAction(state, actions[random() % actions.length], false);
  }
});

test('compact rules preserve promotion, captured-hen demotion, all drops, checks and both colors', () => {
  const positions = [
    fixture([[0, 0, 'king'], [11, 1, 'king'], [2, 0, 'pawn']]),
    fixture([[0, 0, 'king'], [11, 1, 'king'], [4, 0, 'rook'], [5, 1, 'hen']]),
    fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'bishop', 'pawn'], []]),
    fixture([[4, 0, 'king'], [0, 0, 'bishop'], [8, 0, 'pawn'], [5, 1, 'rook'], [11, 1, 'king']], 0, [['pawn'], []]),
    fixture([[2, 0, 'king'], [11, 1, 'king']]),
    fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]),
  ];
  for (const original of positions) for (const state of [original, mirror(original)]) checkChildren(state);
  const promoted = new FastPosition(positions[0]);
  promoted.make(actionCode({ from: 2, to: 3 }));
  assert.equal(promoted.board[3] & 7, 5);
  const captured = new FastPosition(positions[1]);
  captured.make(actionCode({ from: 4, to: 5 }));
  assert.equal(captured.hands[2], 1);
  for (let code = 1; code < 14; code++) if ((code & 7) >= 1 && (code & 7) <= 5) assert.equal(MASKS[code].length, 12);
});

test('compact history imports prior repetitions and make/unmake restores nested cycles', () => {
  let state = fixture([[0, 0, 'king'], [11, 1, 'king']]);
  const cycle = [{ from: 0, to: 4 }, { from: 11, to: 7 }, { from: 4, to: 0 }, { from: 7, to: 11 }];
  for (const action of cycle) state = applyAction(state, action, false);
  const fast = new FastPosition(state), originalKey = fast.key(), originalCounts = new Map(fast.counts), undos = [];
  assert.equal(fast.counts.get(originalKey), 2);
  for (const action of cycle) {
    undos.push(fast.make(actionCode(action)));
    state = applyAction(state, action, false);
    assert.equal(fast.winner(), state.winner);
    checkState(fast, state);
  }
  assert.equal(state.termination, 'repetition');
  assert.equal(fast.winner(), 'draw');
  while (undos.length) fast.unmake(undos.pop());
  assert.equal(fast.key(), originalKey);
  assert.deepEqual(fast.counts, originalCounts);
  assert.equal(fast.winner(), null);
  const terminal = new FastPosition(state);
  assert.equal(terminal.winner(), 'draw');
  assert.deepEqual(terminal.actions(), []);
});

test('compact history preserves exact referee string equality for noncanonical and malformed records', () => {
  const state = fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'bishop'], []]);
  const key = positionKey(state);
  const noncanonical = key.replace('|bishop,rook|', '|rook,bishop|');
  assert.notEqual(noncanonical, key);
  const badKeys = [
    noncanonical,
    RULESET + '|',
    key + '|extra',
    key.replace('|0|', '|00|'),
    key.replace('0king', '0unknown'),
    key.replace('|bishop,rook|', '|bishop,,rook|'),
    key.replace('|bishop,rook|', '|bishop,queen,rook|'),
    key.replace('|bishop,rook|', '|bishop,bishop,bishop,rook|'),
  ];
  for (const bad of badKeys) {
    const imported = { ...state, positions: [bad, bad, key] };
    assert.equal(validatePosition(imported), true);
    assert.equal(adjudicateState(imported).winner, null);
    const fast = new FastPosition(imported);
    assert.equal(fast.counts.get(fast.key()), 1);
    assert.equal(fast.winner(), null);
    checkChildren(imported);
  }
  const repeated = { ...state, positions: [noncanonical, key, key, key] };
  assert.equal(adjudicateState(repeated).winner, 'draw');
  assert.equal(new FastPosition(repeated).winner(), 'draw');
});

test('try and no-legal-actions retain priority over repetition; ply beyond 256 stays playable', () => {
  const positions = [
    fixture([[2, 0, 'king'], [11, 1, 'king']]),
    fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]),
  ];
  for (const state of positions) {
    const action = legalActions(state).find(action => applyAction(state, action, false).winner === state.turn);
    assert.ok(action);
    const nextKey = positionKey(applyAction(state, action, false));
    const historical = { ...state, positions: [nextKey, nextKey, ...state.positions], ply: 300 };
    checkChildren(historical);
    const fast = new FastPosition(historical);
    fast.make(actionCode(action));
    assert.equal(fast.winner(), state.turn);
  }
  checkChildren({ ...initialState(), ply: 400 });
});
