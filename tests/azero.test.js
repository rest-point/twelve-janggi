import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, legalActions, applyAction, positionKey } from '../src/engine.js';
import { initial, legal, step, verdict, fromEngine, fromEngineAction, toEngineAction, historyFromEngine, features, canonAction, initWeights, forward, search, LAYOUT, N_POLICY } from '../models/azero-core.mjs';
import { backward } from '../train/backprop.mjs';

function makeRandom(seed) {
  let n = seed >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
}

test('fast rules match src/engine.js over random games, including repetition and termination', () => {
  const random = makeRandom(7);
  const names = new Set();
  let positions = 0;
  for (let game = 0; game < 400; game++) {
    let e = initialState(game % 2), s = initial(game % 2);
    const seen = new Map([[s.key, 1]]);
    while (e.winner === null && s.ply < 200) {
      const expected = legalActions(e).map(fromEngineAction).sort((a, b) => a - b);
      assert.deepEqual(legal(s).sort((a, b) => a - b), expected);
      assert.equal(verdict(s, legal(s), seen.get(s.key)), null);
      assert.deepEqual([...historyFromEngine(e).entries()].sort(), [...seen.entries()].sort());
      const a = expected[Math.floor(random() * expected.length)];
      e = applyAction(e, toEngineAction(a), false);
      s = step(s, a);
      seen.set(s.key, (seen.get(s.key) || 0) + 1);
      assert.equal(s.key, fromEngine(e).key);
      positions++;
    }
    if (e.winner !== null) {
      names.add(e.termination);
      const got = verdict(s, legal(s), seen.get(s.key));
      assert.equal(got, e.winner === 'draw' ? 0 : e.winner === s.t ? 1 : -1, positionKey(e));
    }
  }
  assert.ok(positions > 5000);
  assert.ok(names.has('try') && names.has('checkmate'), [...names].join());
});

test('backward matches a numeric gradient', () => {
  const random = makeRandom(3), w = initWeights(random), g = new Float64Array(w.length);
  const s = step(initial(0), legal(initial(0))[0]);
  const feats = features(s), acts = legal(s).map(a => canonAction(a, s.t));
  const probs = acts.map((_, i) => (i === 0 ? 1 : 0)), z = -1;
  backward(w, g, feats, acts, probs, z);
  const logits = new Float64Array(N_POLICY);
  const loss = () => {
    const raw = forward(w, feats, acts, logits);
    let total = 0;
    for (let k = 0; k < acts.length; k++) total += Math.exp(logits[k]);
    return -(logits[0] - Math.log(total)) + (Math.tanh(raw) - z) ** 2;
  };
  for (const at of [LAYOUT.w1 + feats[0] * 256 + 5, LAYOUT.b1 + 9, LAYOUT.w2 + 300, LAYOUT.w3 + 700, LAYOUT.p + acts[0] * 256 + 3, LAYOUT.v1 + 40, LAYOUT.v2 + 2, LAYOUT.vb2]) {
    const old = w[at], eps = 1e-2;
    w[at] = old + eps; const up = loss();
    w[at] = old - eps; const down = loss();
    w[at] = old;
    assert.ok(Math.abs((up - down) / (2 * eps) - g[at]) < 2e-3, `weight ${at}: ${(up - down) / (2 * eps)} vs ${g[at]}`);
  }
});

test('search leaves repetition counts untouched and finds an immediate try', () => {
  const w = initWeights(makeRandom(5));
  const s = initial(0), seen = new Map([[s.key, 1]]);
  const root = search(s, seen, w, { sims: 200 });
  assert.equal(root.N.reduce((a, b) => a + b, 0), 200);
  assert.deepEqual([...seen.values()].filter(n => n !== 0), [1]);
  // Blue king one step from the far row, with nothing able to answer.
  const b = new Int8Array(12), h = new Int8Array(6);
  b[2] = 1; b[9] = 6;
  const near = { b, h, t: 0, ply: 0, key: 12345 };
  const found = search(near, new Map([[12345, 1]]), w, { sims: 400 });
  const pick = found.acts[found.N.indexOf(Math.max(...found.N))];
  assert.equal(pick % 12 % 4, 3);
});
