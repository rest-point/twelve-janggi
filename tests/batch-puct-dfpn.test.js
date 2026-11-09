import test from 'node:test';
import assert from 'node:assert/strict';
import { think, searchBatch } from '../models/batch-puct-dfpn-v1.mjs';
import { think as scalarThink } from '../models/pv-puct-dfpn-v1.mjs';
import { batchPolicyValue } from '../models/batch-policy-value-v1.mjs';
import { initialState, createPosition, legalActions, applyAction, isLegalAction, positionKey } from '../src/engine.js';

const config = { simulations: 128, batchSize: 8, maxTimeMs: 55000, rootProofNodes: 0, leafProofNodes: 0 };
const request = (state, overrides = {}) => ({ state, legalActions: legalActions(state), budgetMs: 60000, seed: 7, config, ...overrides });
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);for (const [sq, side, kind] of pieces) board[sq] = { side, kind };
  return createPosition({ board, hands, turn });
}
function mirror(s) { return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn }); }
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function forceWin(s, side, depth) {
  if (s.winner !== null) return s.winner === side;if (!depth) return false;
  const values = legalActions(s).map(a => forceWin(applyAction(s, a, false), side, depth - 1));
  return s.turn === side ? values.some(Boolean) : values.every(Boolean);
}

test('batched PUCT performs genuine multiple-position evaluations and clears every virtual reservation', () => {
  const calls = [], state = initialState();
  const result = searchBatch(request(state), (queries, t) => {
    calls.push(queries.length);
    for (const { position: p } of queries) {
      assert.equal(p.key(), String.fromCharCode(...p.board, ...p.hands, p.turn));
      assert.ok(p.counts.get(p.key()) >= 1);
    }
    return batchPolicyValue(queries, t);
  });
  assert.equal(result.diagnostics.completedSimulations, 128);
  assert.ok(calls.some(n => n > 1));assert.ok(calls.every(n => n <= 8));
  assert.ok(result.diagnostics.nnBatches < result.diagnostics.nnRows);
  assert.equal(result.diagnostics.virtualReservations, 0);
  assert.equal(isLegalAction(state, result.action), true);
});

test('batch size one reproduces scalar PUCT actions and work over varied reachable positions', () => {
  let state = initialState();
  for (let i = 0; i < 24; i++) {
    if (state.winner !== null) state = initialState(i % 2);
    const options = { ...config, batchSize: 1, simulations: 64, cacheEntries: 0 };
    const batch = searchBatch(request(state, { config: options })), scalar = scalarThink(request(state, { config: options }));
    assert.deepEqual(batch.action, scalar.action);
    assert.equal(batch.info.nodes, scalar.info.nodes);
    assert.equal(batch.diagnostics.virtualReservations, 0);
    const actions = legalActions(state);state = applyAction(state, actions[(i * 7 + 3) % actions.length], false);
  }
});

test('partial batches respect simulation limits, cache behavior and deterministic request isolation', () => {
  const state = initialState();
  for (const simulations of [1, 3, 7, 9, 17]) for (const batchSize of [4, 8, 16, 32]) {
    const options = { ...config, simulations, batchSize };
    const result = searchBatch(request(state, { config: options }));
    assert.equal(result.diagnostics.completedSimulations, simulations);
    assert.equal(result.diagnostics.virtualReservations, 0);
    assert.equal(isLegalAction(state, result.action), true);
  }
  const first = searchBatch(request(state));think(request(initialState(1)));
  const repeated = searchBatch(request(state));
  assert.deepEqual(first.action, repeated.action);assert.deepEqual(first.diagnostics, repeated.diagnostics);
  const uncached = searchBatch(request(state, { config: { ...config, cacheEntries: 0 } }));
  assert.deepEqual(first.action, uncached.action);
});

test('batch search prefers immediate try/mate/no-action wins and DFPN-proved three-ply wins for both sides', () => {
  const states = [fixture([[2, 0, 'king'], [11, 1, 'king']]), fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]), fixture([[0, 0, 'king'], [6, 1, 'king'], [4, 1, 'bishop']], 1)];
  for (const original of states) for (const state of [original, mirror(original)]) assert.equal(applyAction(state, think(request(state)).action, false).winner, state.turn);
  const forced = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  for (const state of [forced, mirror(forced)]) {
    const wins = legalActions(state).filter(a => forceWin(applyAction(state, a, false), state.turn, 2));
    assert.equal(wins.length, 1);
    const result = searchBatch(request(state, { config: { ...config, simulations: 1, rootProofNodes: 10000, proofDepth: 3 } }));
    assert.deepEqual(result.action, wins[0]);assert.equal(result.diagnostics.virtualReservations, 0);
  }
});

test('pending batches cancel without backpropagating incomplete results or leaking virtual loss', t => {
  for (const interruptAfterRoot of [false, true]) {
    let time = 0, calls = 0;
    const mocked = t.mock.method(performance, 'now', () => time);
    try {
      const state = initialState();
      const result = searchBatch(request(state, { config: { ...config, maxTimeMs: 100 } }), (queries, temp) => {
        calls++;
        const values = batchPolicyValue(queries, temp);
        if (!interruptAfterRoot || calls > 1) time = 101;
        return values;
      });
      assert.equal(result.diagnostics.completedSimulations, 0);
      assert.equal(result.diagnostics.virtualReservations, 0);
      assert.equal(calls, interruptAfterRoot ? 2 : 1);
      assert.equal(isLegalAction(state, result.action), true);
    } finally { mocked.mock.restore(); }
  }
});

test('batch search preserves exact histories, frozen inputs, hands and states beyond ply 256', () => {
  const state = fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'bishop', 'pawn'], []]);
  for (const s of [state, mirror(state), { ...initialState(), ply: 400 }]) {
    const input = freeze(request(s)), before = structuredClone(input), r = searchBatch(input);
    assert.deepEqual(input, before);assert.equal(isLegalAction(s, r.action), true);assert.equal(r.diagnostics.virtualReservations, 0);
  }
  const base = fixture([[0, 0, 'king'], [11, 1, 'king']]), action = { from: 0, to: 4 };
  const key = positionKey(applyAction(base, action, false));
  const repeated = { ...base, positions: [key, key, ...base.positions] };
  const result = searchBatch(request(repeated, { legalActions: [action] }));
  assert.deepEqual(result.action, action);assert.equal(result.diagnostics.completedSimulations, 1);
  assert.equal(applyAction(repeated, action, false).winner, 'draw');
  for (const budgetMs of [0, 1, 5]) {
    const r = searchBatch(request(initialState(), { budgetMs }));
    assert.equal(r.info.nodes, 0);assert.equal(r.diagnostics.virtualReservations, 0);
  }
});
