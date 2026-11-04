// Hand-written gradient for models/azero-core.mjs forward(); checked numerically in tests/azero.test.js.
import { forward, net, LAYOUT as O, H, VH, N_POLICY } from '../models/azero-core.mjs';

const logits = new Float64Array(N_POLICY), e1 = new Float64Array(H), e2 = new Float64Array(H), e3 = new Float64Array(H), ev = new Float64Array(VH);
// Adds d(loss)/d(w) to g. Loss = cross entropy(policy, probs) + (tanh(value) - z)^2.
export function backward(w, g, feats, acts, probs, z) {
  const raw = forward(w, feats, acts, logits), { h1, h2, h3, m2, m3, hv } = net;
  let top = -Infinity, total = 0;
  for (let k = 0; k < acts.length; k++) if (logits[k] > top) top = logits[k];
  for (let k = 0; k < acts.length; k++) total += logits[k] = Math.exp(logits[k] - top);
  let policyLoss = 0;
  e3.fill(0);
  for (let k = 0; k < acts.length; k++) {
    const p = logits[k] / total, diff = p - probs[k], at = O.p + acts[k] * H;
    if (probs[k] > 0) policyLoss -= probs[k] * Math.log(p + 1e-12);
    g[O.pb + acts[k]] += diff;
    for (let j = 0; j < H; j++) { g[at + j] += diff * h3[j]; e3[j] += diff * w[at + j]; }
  }
  const v = Math.tanh(raw), dv = 2 * (v - z) * (1 - v * v), valueLoss = (v - z) ** 2;
  g[O.vb2] += dv;
  for (let i = 0; i < VH; i++) {
    g[O.v2 + i] += dv * hv[i];
    ev[i] = hv[i] > 0 ? dv * w[O.v2 + i] : 0;
    if (ev[i] === 0) continue;
    const at = O.v1 + i * H;
    g[O.vb1 + i] += ev[i];
    for (let j = 0; j < H; j++) { g[at + j] += ev[i] * h3[j]; e3[j] += ev[i] * w[at + j]; }
  }
  e2.set(e3);
  for (let i = 0; i < H; i++) {
    if (m3[i] <= 0 || e3[i] === 0) continue;
    const at = O.w3 + i * H, d = e3[i];
    g[O.b3 + i] += d;
    for (let j = 0; j < H; j++) { g[at + j] += d * h2[j]; e2[j] += d * w[at + j]; }
  }
  e1.set(e2);
  for (let i = 0; i < H; i++) {
    if (m2[i] <= 0 || e2[i] === 0) continue;
    const at = O.w2 + i * H, d = e2[i];
    g[O.b2 + i] += d;
    for (let j = 0; j < H; j++) { g[at + j] += d * h1[j]; e1[j] += d * w[at + j]; }
  }
  for (let j = 0; j < H; j++) {
    if (h1[j] <= 0) continue;
    g[O.b1 + j] += e1[j];
    for (const f of feats) g[O.w1 + f * H + j] += e1[j];
  }
  return { policyLoss, valueLoss };
}
