// Derived from azero-core.mjs PUCT. Rules/network/weights are unchanged.
// A root-perspective draw preference affects search utility, never adjudication.
import { legal, verdict, features, canonAction, forward, step, N_POLICY } from './azero-core.mjs';
const logits = new Float64Array(N_POLICY);
function node(s, seen, weights, maxPly) {
  const acts = legal(s), term = verdict(s, acts, seen, maxPly);
  if (term !== null) return { term, t: s.t, n: 0, sum: 0 };
  const raw = forward(weights, features(s, seen), acts.map(a => canonAction(a, s.t)), logits);
  let top = -Infinity, total = 0;
  for (let i = 0; i < acts.length; i++) top = Math.max(top, logits[i]);
  const P = new Float32Array(acts.length);
  for (let i = 0; i < acts.length; i++) total += P[i] = Math.exp(logits[i] - top);
  for (let i = 0; i < acts.length; i++) P[i] /= total;
  return { term: null, t: s.t, s, acts, P, N: new Int32Array(acts.length), W: new Float32Array(acts.length),
    kids: new Array(acts.length), v: Math.tanh(raw), n: 0, sum: 0 };
}
export function search(root, seen, weights, { sims = 800, cpuct = 1.5, contempt = 0, maxPly = 256 } = {}) {
  seen.set(root.key, seen.get(root.key) || 1);
  const top = node(root, seen.get(root.key), weights, maxPly);
  if (top.term !== null) return top;
  const path = [], taken = [];
  for (let sim = 0; sim < sims; sim++) {
    let current = top, value;
    path.length = taken.length = 0;
    for (;;) {
      const explore = cpuct * Math.sqrt(current.n + 1), fpu = (current.n ? current.sum / current.n : current.v) - 0.2;
      let best = 0, bestU = -Infinity;
      for (let i = 0; i < current.acts.length; i++) {
        const u = (current.N[i] ? current.W[i] / current.N[i] : fpu) + explore * current.P[i] / (1 + current.N[i]);
        if (u > bestU) { bestU = u; best = i; }
      }
      path.push(current); taken.push(best);
      let kid = current.kids[best];
      if (!kid) {
        const s = step(current.s, current.acts[best]), count = (seen.get(s.key) || 0) + 1;
        seen.set(s.key, count);
        kid = current.kids[best] = node(s, count, weights, maxPly);
        kid.key = s.key;
      } else seen.set(kid.key, seen.get(kid.key) + 1);
      if (kid.term !== null || kid.n === 0) {
        value = kid.term === 0 ? (kid.t === root.t ? -contempt : contempt) : kid.term !== null ? kid.term : kid.v;
        kid.n++; kid.sum += value;
        seen.set(kid.key, seen.get(kid.key) - 1);
        break;
      }
      current = kid;
    }
    for (let d = path.length - 1; d >= 0; d--) {
      value = -value;
      const up = path[d], i = taken[d];
      up.N[i]++; up.W[i] += value; up.n++; up.sum += value;
      if (d > 0) seen.set(up.key, seen.get(up.key) - 1);
    }
  }
  return top;
}
