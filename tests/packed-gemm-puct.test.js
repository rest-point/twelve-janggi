import test from 'node:test';
import assert from 'node:assert/strict';
import { think } from '../models/packed-gemm-puct-v1.mjs';
import { think as baseline } from '../models/batch-puct-dfpn-v1.mjs';
import { initialState, legalActions, applyAction, createPosition, isLegalAction } from '../src/engine.js';

const config = { simulations: 96, maxTimeMs: 55000, batchSize: 8, rootProofNodes: 0, leafProofNodes: 0 };
const request = (state, overrides = {}) => ({ state, legalActions: legalActions(state), config, budgetMs: 60000, seed: 11, ...overrides });
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);for (const [sq, side, kind] of pieces) board[sq] = { side, kind };
  return createPosition({ board, hands, turn });
}
function mirror(s) { return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn }); }
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

test('packed kernel preserves batched search choices and work on varied positions and partial batches', () => {
  let state = initialState();
  for (let i = 0; i < 32; i++) {
    if (state.winner !== null) state = initialState(i % 2);
    const options = { ...config, simulations: i % 2 ? 19 : 96, batchSize: [1, 4, 8, 16, 32][i % 5] };
    const a = think(request(state, { config: options })), b = baseline(request(state, { config: options }));
    assert.deepEqual(a.action, b.action);assert.equal(a.info.nodes, b.info.nodes);
    const moves = legalActions(state);state = applyAction(state, moves[(i * 11 + 5) % moves.length], false);
  }
});

test('packed model retains exact wins, DFPN decisions, inputs, long-game and budget behavior', () => {
  const immediate = fixture([[2, 0, 'king'], [11, 1, 'king']]);
  const forced = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  const hand = fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'bishop', 'pawn'], []]);
  const options = { ...config, rootProofNodes: 10000, leafProofNodes: 40, proofDepth: 3 };
  for (const original of [immediate, forced, hand]) for (const state of [original, mirror(original)]) {
    const input = freeze(request(state, { config: options })), before = structuredClone(input);
    const a = think(input), b = baseline(input);
    assert.equal(isLegalAction(state, a.action), true);assert.deepEqual(a.action, b.action);
    assert.deepEqual(input, before);
    if (original === immediate) assert.equal(applyAction(state, a.action, false).winner, state.turn);
  }
  const state = initialState();
  assert.deepEqual(think(request({ ...state, ply: 400 })).action, think(request(state)).action);
  for (const budgetMs of [0, 1, 5]) {
    const result = think(request(state, { budgetMs }));
    assert.equal(isLegalAction(state, result.action), true);assert.equal(result.info.nodes, 0);
  }
});
