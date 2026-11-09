import test from 'node:test';
import assert from 'node:assert/strict';
import { batchPolicyValue } from '../models/batch-policy-value-v1.mjs';
import { packedBatchPolicyValue } from '../models/packed-gemm-policy-value-v1.mjs';
import { readFileSync } from 'node:fs';
import { LAYOUT } from '../models/azero-core.mjs';
import { policyValue } from '../models/pv-puct-network-v1.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { applyAction, createPosition, initialState, legalActions } from '../src/engine.js';

function snapshot(requests) {
  return requests.map(({ position: p, actions }) => ({ board: [...p.board], hands: [...p.hands], kings: [...p.kings], turn: p.turn, winner: p._winner, counts: new Map(p.counts), actions: [...actions] }));
}
function compare(requests, temperature = 1) {
  const before = snapshot(requests);
  const expected = requests.map(({ position, actions }) => policyValue(position, actions, temperature));
  const actual = packedBatchPolicyValue(requests, temperature);
  const legacyBatch = batchPolicyValue(requests, temperature);
  assert.equal(actual.length, requests.length);
  for (let row = 0; row < actual.length; row++) {
    const got = actual[row], want = expected[row];
    assert.ok(Number.isFinite(got.value) && got.value >= -1 && got.value <= 1);
    assert.ok(Math.abs(got.value - want.value) <= 1e-10);
    assert.ok(Math.abs(got.value - legacyBatch[row].value) <= 1e-10);
    assert.equal(got.prior.length, want.prior.length);
    assert.ok(got.prior instanceof Float64Array);
    for (let i = 0; i < got.prior.length; i++) {
      assert.ok(Number.isFinite(got.prior[i]) && got.prior[i] >= 0 && got.prior[i] <= 1);
      assert.ok(Math.abs(got.prior[i] - want.prior[i]) <= 1e-10);
      assert.ok(Math.abs(got.prior[i] - legacyBatch[row].prior[i]) <= 1e-10);
    }
    if (got.prior.length) assert.ok(Math.abs(got.prior.reduce((sum, probability) => sum + probability, 0) - 1) < 1e-12);
  }
  assert.deepEqual(snapshot(requests), before);
  return actual;
}
function corpus() {
  let state = initialState(), seed = 20261106;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const requests = [];
  for (let i = 0; i < 200; i++) {
    if (state.winner !== null || state.ply >= 160) state = initialState(i % 2);
    const position = new FastPosition(state), actions = position.actions();
    // Different caller action orders must remain paired with their own priors.
    if (i % 3 === 0) actions.reverse();
    requests.push({ position, actions: Object.freeze(actions) });
    const moves = legalActions(state);
    state = applyAction(state, moves[random() % moves.length], false);
  }
  return requests;
}
const requests = corpus();

test('packed GEMM CPU MLP matches scalar policy/value on 200 positions at batch sizes 1/4/8/16/32', () => {
  assert.ok(requests.some(request => request.position.turn === 1));
  assert.ok(requests.some(request => request.actions.some(action => action >= 144)));
  for (const size of [1, 4, 8, 16, 32]) {
    for (let at = 0; at < requests.length; at += size) compare(requests.slice(at, at + size), [0.5, 1, 2][Math.floor(at / size) % 3]);
  }
});

test('packed GEMM CPU MLP supports partial lanes, mixed repetition counts, hands and color rotations', () => {
  const board = Array(12).fill(null);
  board[0] = { side: 0, kind: 'king' }; board[11] = { side: 1, kind: 'king' };
  const state = createPosition({ board, hands: [['rook', 'bishop', 'pawn'], ['pawn']] });
  const mirrored = createPosition({ board: [...state.board].reverse().map(piece => piece ? { side: 1 - piece.side, kind: piece.kind } : null), hands: [state.hands[1], state.hands[0]], turn: 1 });
  const mixed = [];
  for (let i = 0; i < 32; i++) {
    const position = new FastPosition(i % 2 ? mirrored : state);
    position.counts.set(position.key(), i % 3 + 1);
    mixed.push({ position, actions: position.actions() });
  }
  for (const size of [1, 3, 4, 7, 8, 15, 16, 31, 32]) for (const temperature of [0.1, 1, 5]) compare(mixed.slice(0, size), temperature);
});

test('packed GEMM predictions are separate per row and per call, including reordered legal lists', () => {
  const request = requests[0], other = { position: request.position, actions: [...request.actions].reverse() };
  const output = compare([request, request, other]);
  const expected = [...output[1].prior], expectedValue = output[1].value;
  output[0].prior.fill(0); output[0].value = -1;
  assert.deepEqual([...output[1].prior], expected);
  assert.equal(output[1].value, expectedValue);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(output[2].prior[i] - expected[expected.length - 1 - i]) < 1e-14);
  assert.deepEqual([...packedBatchPolicyValue([request])[0].prior], expected);
});

test('packed GEMM inference accepts zero requests and enforces its row/temperature bounds', () => {
  assert.deepEqual(packedBatchPolicyValue([]), []);
  assert.throws(() => packedBatchPolicyValue(Array(33).fill(requests[0])), /32/);
  assert.throws(() => packedBatchPolicyValue(null), /array/);
  for (const temperature of [0, -1, NaN, Infinity]) assert.throws(() => packedBatchPolicyValue([requests[0]], temperature), /temperature/i);
  const invalid = { position: requests[0].position, actions: [180] };
  assert.throws(() => packedBatchPolicyValue([invalid]), /action/);
});


test('packed GEMM supports frozen inference snapshots and unchanged actual weight bounds', () => {
  const bytes = readFileSync(new URL('../models/azero-v2.bin', import.meta.url));
  assert.equal(bytes.byteLength, LAYOUT.size * Float32Array.BYTES_PER_ELEMENT);
  const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(weights.every(Number.isFinite));
  assert.ok(weights.some(value => value !== 0));
  const original = requests[7].position, key = original.key();
  const position = Object.freeze({
    board: Object.freeze([...original.board]), hands: Object.freeze([...original.hands]),
    kings: Object.freeze([...original.kings]), turn: original.turn, _winner: null,
    counts: Object.freeze(new Map(original.counts)), key: () => key,
  });
  const request = Object.freeze({ position, actions: Object.freeze([...requests[7].actions]) });
  compare(Object.freeze([request, request, request]), 0.5);
});
