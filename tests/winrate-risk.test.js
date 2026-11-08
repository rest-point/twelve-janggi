import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState, legalActions, applyAction, positionKey } from '../src/engine.js';
import { fromEngine, historyFromEngine, search as original } from '../models/azero-core.mjs';
import { search } from '../models/lab-risk-core-v1.mjs';
const bytes = readFileSync(new URL('../models/azero-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

test('zero draw preference preserves the original PUCT visit counts and values for both starters', () => {
  for (const turn of [0, 1]) {
    const state = initialState(turn), one = historyFromEngine(state), two = historyFromEngine(state);
    const before = new Map(two);
    const a = original(fromEngine(state), one, weights, { sims: 120 });
    const b = search(fromEngine(state), two, weights, { sims: 120, contempt: 0 });
    assert.deepEqual(a.acts, b.acts);
    assert.deepEqual(a.N, b.N);
    assert.deepEqual(a.W, b.W);
    assert.equal(a.sum, b.sum);
    for (const [key, count] of before) assert.equal(two.get(key), count);
    assert.ok([...two].filter(([key]) => !before.has(key)).every(([, count]) => count === 0));
  }
});

test('draw search utility is negative for the root of either colour while actual referee results stay draws', () => {
  for (const turn of [0, 1]) {
    const state = initialState(turn);
    state.positions.push(...legalActions(state).flatMap(action => {
      const key = positionKey(applyAction(state, action, false));
      return [key, key];
    }));
    const before = structuredClone(state);
    for (const action of legalActions(state)) assert.equal(applyAction(state, action, false).winner, 'draw');
    const seen = historyFromEngine(state), counts = new Map(seen);
    const root = search(fromEngine(state), seen, weights, { sims: 120, contempt: 0.25 });
    assert.equal(root.sum, -30);
    for (let i = 0; i < root.N.length; i++) if (root.N[i]) assert.equal(root.W[i] / root.N[i], -0.25);
    assert.deepEqual(seen, counts);
    assert.deepEqual(state, before);
  }
});
