import { parentPort, workerData } from 'node:worker_threads';
import { initial, legal, step, verdict, features, canonAction, search } from '../models/azero-core.mjs';

const shared = new Float32Array(workerData.weights), w = new Float32Array(shared.length), { sims } = workerData;
function gamma(alpha) {
  if (alpha < 1) return gamma(alpha + 1) * Math.random() ** (1 / alpha);
  const d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()), v = (1 + c * x) ** 3;
    if (v > 0 && Math.log(1 - Math.random()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
function dirichlet(n) {
  const out = Array.from({ length: n }, () => gamma(0.5)), total = out.reduce((a, b) => a + b, 0);
  return out.map(x => x / total);
}
function playGame() {
  w.set(shared);
  let s = initial(Math.random() < 0.5 ? 0 : 1);
  const seen = new Map([[s.key, 1]]), samples = [];
  // Random openings cover positions self-play alone would never reach.
  if (Math.random() < 0.25) for (let i = Math.floor(Math.random() * 7); i > 0; i--) {
    const acts = legal(s), a = acts[Math.floor(Math.random() * acts.length)], n = step(s, a), count = (seen.get(n.key) || 0) + 1;
    if (verdict(n, legal(n), count) !== null) break;
    s = n; seen.set(n.key, count);
  }
  const start = s.ply;
  let result;
  for (;;) {
    const acts = legal(s), term = verdict(s, acts, seen.get(s.key));
    if (term !== null) { result = { lastTurn: s.t, term }; break; }
    const root = search(s, seen, w, { sims, noise: { eps: 0.25, sample: dirichlet(acts.length) } });
    const total = root.N.reduce((a, b) => a + b, 0);
    samples.push({ f: Uint8Array.from(features(s, seen.get(s.key))), a: Uint8Array.from(root.acts.map(a => canonAction(a, s.t))), p: Float32Array.from(root.N, n => n / total), t: s.t });
    let pick = 0;
    if (s.ply - start < 8) { let r = Math.random() * total; while (pick < root.N.length - 1 && (r -= root.N[pick]) >= 0) pick++; }
    else pick = root.N.indexOf(Math.max(...root.N));
    s = step(s, root.acts[pick]);
    seen.set(s.key, (seen.get(s.key) || 0) + 1);
  }
  for (const x of samples) { x.z = result.term === 0 ? 0 : x.t === result.lastTurn ? result.term : -result.term; delete x.t; }
  return { samples, plies: samples.length, draw: result.term === 0 };
}
for (;;) parentPort.postMessage(playGame());
