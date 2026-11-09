import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { policyValue } from '../models/pv-puct-network-v1.mjs';
import { FastPosition, actionCode } from '../models/pvs-aspiration-rules-v1.mjs';
import { LAYOUT, N_POLICY, features, forward, canonAction, fromEngine } from '../models/azero-core.mjs';
import { applyAction, createPosition, initialState, legalActions } from '../src/engine.js';

const bytes = readFileSync(new URL('../models/azero-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
function reference(state, actions, seen, temperature) {
  const encoded = fromEngine(state), logits = new Float64Array(actions.length);
  const value = Math.tanh(forward(weights, features(encoded, seen), actions.map(action => canonAction(action, state.turn)), logits));
  const largest = Math.max(...logits), prior = Array.from(logits, value => Math.exp((value - largest) / temperature));
  const total = prior.reduce((sum, value) => sum + value, 0);
  return { value, prior: prior.map(value => value / total) };
}
function snapshot(p) {
  return { board: [...p.board], hands: [...p.hands], kings: [...p.kings], turn: p.turn, counts: new Map(p.counts), winner: p._winner };
}
function compare(state, temperature = 1, repetitions) {
  const before = structuredClone(state), p = new FastPosition(state), actions = Object.freeze(legalActions(state).map(actionCode));
  if (repetitions !== undefined) p.counts.set(p.key(), repetitions);
  const original = snapshot(p), seen = p.counts.get(p.key()) || 0;
  const expected = reference(state, actions, seen, temperature), actual = policyValue(p, actions, temperature);
  assert.equal(actual.value, expected.value);
  assert.ok(actual.value >= -1 && actual.value <= 1 && Number.isFinite(actual.value));
  assert.equal(actual.prior.length, actions.length);
  assert.ok(actual.prior.length > 0 && actual.prior.length <= N_POLICY);
  for (let i = 0; i < actual.prior.length; i++) {
    assert.ok(Number.isFinite(actual.prior[i]) && actual.prior[i] >= 0 && actual.prior[i] <= 1);
    assert.ok(Math.abs(actual.prior[i] - expected.prior[i]) < 1e-14);
  }
  assert.ok(Math.abs(actual.prior.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.deepEqual(snapshot(p), original);
  assert.deepEqual(state, before);
  return actual;
}
function mirror(state) {
  return createPosition({ board: [...state.board].reverse().map(piece => piece ? { side: 1 - piece.side, kind: piece.kind } : null), hands: [state.hands[1], state.hands[0]], turn: 1 - state.turn });
}

test('policy/value adapter reads the actual finite trained weights with the expected layout', () => {
  assert.equal(bytes.byteLength, LAYOUT.size * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(weights.length, 228917);
  assert.ok(weights.every(Number.isFinite));
  assert.ok(weights.some(value => value !== 0));
});

test('policy/value adapter agrees with the original neural API over 200 reachable positions', () => {
  let state = initialState(), seed = 20261106, sawDrops = false, sawRed = false;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 200; i++) {
    if (state.winner !== null || state.ply >= 160) state = initialState(i % 2);
    sawRed ||= state.turn === 1;
    const actions = legalActions(state);
    sawDrops ||= actions.some(action => action.drop);
    compare(state, [0.1, 0.5, 1, 2, 5][i % 5]);
    state = applyAction(state, actions[random() % actions.length], false);
  }
  assert.ok(sawDrops && sawRed);
});

test('policy/value adapter preserves mover perspective and action rotation for either color', () => {
  let state = initialState();
  for (let i = 0; i < 6; i++) {
    const original = compare(state), rotated = compare(mirror(state));
    // Rotating board and ownership keeps the mover's canonical NN input and
    // value exactly unchanged. Action order may differ, so compare by rotation.
    assert.equal(original.value, rotated.value);
    const actions = legalActions(state).map(actionCode), other = legalActions(mirror(state)).map(actionCode);
    for (let j = 0; j < actions.length; j++) {
      const index = other.indexOf(canonAction(actions[j], 1));
      assert.ok(index >= 0);
      assert.ok(Math.abs(original.prior[j] - rotated.prior[index]) < 1e-14);
    }
    const next = legalActions(state).filter(action => applyAction(state, action, false).winner === null);
    if (!next.length) break;
    state = applyAction(state, next[(i * 7 + 1) % next.length], false);
  }
});

test('policy/value adapter includes current repetitions and evaluates all hand-drop kinds', () => {
  const board = Array(12).fill(null);
  board[0] = { side: 0, kind: 'king' }; board[11] = { side: 1, kind: 'king' };
  const original = createPosition({ board, hands: [['rook', 'bishop', 'pawn'], ['pawn']], turn: 0 });
  for (const state of [original, mirror(original)]) {
    assert.deepEqual([...new Set(legalActions(state).filter(action => action.drop).map(action => action.drop))].sort(), ['bishop', 'pawn', 'rook']);
    for (const seen of [1, 2]) compare(state, 1, seen);
    // The NN contains two repetition feature slots. Even its terminal-three
    // encoding remains compatible; the search adjudicates before calling it.
    compare(state, 1, 3);
  }
});

test('temperature changes only policy sharpness and predictions never alias later calls', () => {
  const state = initialState(), p = new FastPosition(state), actions = p.actions();
  const sharp = compare(state, 0.1), flat = compare(state, 5);
  assert.equal(sharp.value, flat.value);
  assert.ok(Math.max(...sharp.prior) >= Math.max(...flat.prior));
  const output = policyValue(p, actions), expected = [...output.prior];
  output.prior.fill(0);
  const other = new FastPosition(initialState(1));
  policyValue(other, other.actions(), 0.5);
  assert.deepEqual([...policyValue(p, actions).prior], expected);
});
