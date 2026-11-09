// Self-play with Gumbel AlphaZero root (ICLR 2022), playout cap randomization (KataGo) and an
// opponent pool share against a frozen network (AlphaStar-style exploiter pressure).
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { initial, legal, step, verdict, features, canonAction, search } from '../models/azero-core.mjs';

import { gumbelSearch } from './gumbel.mjs';

const shared = new Float32Array(workerData.weights), w = new Float32Array(shared.length), { sims } = workerData;
const frozen = workerData.frozen ? new Float32Array(readFileSync(workerData.frozen).buffer.slice(0)) : null;
const FULL_RATE = 0.25, FAST = 32, FROZEN_RATE = 0.3, FROZEN_SIMS = 200;
function frozenMove(s, seen, opening) {
  const root = search(s, seen, frozen, { sims: FROZEN_SIMS });
  if (opening < 4) { let r = Math.random() * FROZEN_SIMS, i = 0; while (i < root.N.length - 1 && (r -= root.N[i]) >= 0) i++; return root.acts[i]; }
  return root.acts[root.N.indexOf(Math.max(...root.N))];
}
function playGame() {
  w.set(shared);
  let s = initial();
  const versus = frozen && Math.random() < FROZEN_RATE, learner = Math.random() < 0.5 ? 0 : 1;
  const seen = new Map([[s.key, 1]]), samples = [];
  if (Math.random() < (versus ? 0.5 : 0.25)) for (let i = Math.floor(Math.random() * 7); i > 0; i--) {
    const acts = legal(s), a = acts[Math.floor(Math.random() * acts.length)], n = step(s, a), count = (seen.get(n.key) || 0) + 1;
    if (verdict(n, legal(n), count) !== null) break;
    s = n; seen.set(n.key, count);
  }
  const start = s.ply;
  let plies = 0, term, last;
  for (;;) {
    const acts = legal(s);
    term = verdict(s, acts, seen.get(s.key)); last = s.t;
    if (term !== null) break;
    let pick;
    if (versus && s.t !== learner) pick = frozenMove(s, seen, s.ply - start);
    else {
      const full = Math.random() < FULL_RATE, r = gumbelSearch(s, seen, w, acts, full ? sims : FAST);
      pick = r.pick;
      if (full) { samples.push({ f: Uint8Array.from(features(s, seen.get(s.key))), a: Uint8Array.from(acts.map(a => canonAction(a, s.t))), p: Float32Array.from(r.target), t: s.t }); plies++; }
    }
    s = step(s, pick);
    seen.set(s.key, (seen.get(s.key) || 0) + 1);
  }
  for (const x of samples) { x.z = term === 0 ? 0 : x.t === last ? term : -term; delete x.t; }
  const score = versus ? (term === 0 ? 0.5 : (last === learner) === (term === 1) ? 1 : 0) : null;
  return { samples, plies, draw: term === 0, frozenScore: score };
}
for (;;) parentPort.postMessage(playGame());
