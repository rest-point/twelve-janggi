// Gumbel AlphaZero root (Danihelka et al., ICLR 2022): sample actions without replacement, spend the
// budget by sequential halving, and train on the completed-Q improved policy instead of visit counts.
import { step, features, canonAction, forward, search, N_POLICY } from '../models/azero-core.mjs';

const logits = new Float64Array(N_POLICY);
// ponytail: each round re-searches a child from scratch (about 2x the sims), a shared tree would reuse them.
export function gumbelSearch(s, seen, w, acts, budget) {
  const n = acts.length, v = Math.tanh(forward(w, features(s, seen.get(s.key)), acts.map(a => canonAction(a, s.t)), logits));
  const base = Array.from(acts, (_, i) => logits[i]), gumbel = acts.map(() => -Math.log(-Math.log(Math.random() || 1e-12)));
  let alive = acts.map((_, i) => i).sort((x, y) => base[y] + gumbel[y] - base[x] - gumbel[x]).slice(0, budget < 64 ? 4 : 16);
  const q = new Float64Array(n), N = new Int32Array(n), rounds = Math.max(1, Math.ceil(Math.log2(alive.length)));
  for (let r = 0; r < rounds && n > 1; r++) {
    const per = Math.max(1, Math.floor(budget / (rounds * alive.length)));
    for (const i of alive) {
      N[i] += per;
      const child = step(s, acts[i]), count = (seen.get(child.key) || 0) + 1;
      seen.set(child.key, count);
      const node = search(child, seen, w, { sims: N[i] });
      q[i] = node.term !== null ? -node.term : -(node.v + node.sum) / (1 + node.n);
      seen.set(child.key, count - 1);
    }
    alive.sort((x, y) => q[y] - q[x]);
    alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
  }
  const top = Math.max(...base), prior = base.map(x => Math.exp(x - top)), total = prior.reduce((a, b) => a + b, 0);
  let visits = 0, mass = 0, sum = 0, maxN = 0;
  for (let i = 0; i < n; i++) if (N[i]) { visits += N[i]; mass += prior[i] / total; sum += prior[i] / total * q[i]; maxN = Math.max(maxN, N[i]); }
  const mix = (v + (visits && mass ? visits * sum / mass : 0)) / (1 + visits);
  const done = Array.from(q, (x, i) => (N[i] ? x : mix)), low = Math.min(...done), span = Math.max(...done) - low || 1;
  const score = base.map((x, i) => x + (50 + maxN) * 0.1 * (done[i] - low) / span), peak = Math.max(...score);
  const raw = score.map(x => Math.exp(x - peak)), sumRaw = raw.reduce((a, b) => a + b, 0);
  return { pick: acts[n > 1 ? alive[0] : 0], target: raw.map(x => x / sumRaw), q, N };
}
