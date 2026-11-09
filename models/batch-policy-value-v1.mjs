import { readFileSync } from 'node:fs';
import { features, canonAction, LAYOUT, H, VH, N_POLICY } from './azero-core.mjs';

// CPU matrix batches only. The trained twelve-janggi MLP is evaluated directly;
// neither ONNX Runtime nor DirectML/GPU execution is used by this adapter.
const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
if (bytes.byteLength !== LAYOUT.size * Float32Array.BYTES_PER_ELEMENT) throw new Error('Invalid batched policy/value weight length');
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
if (!weights.every(Number.isFinite)) throw new Error('Nonfinite batched policy/value weights');

// Row-major X times W-transpose. Four rows share each loaded dense weight;
// each row retains the scalar network's original ascending accumulation order.
function dense(input, width, outputs, wAt, bAt, rows, relu, residual = null) {
  const result = new Float64Array(rows * outputs);
  for (let out = 0; out < outputs; out++) {
    const at = wAt + out * width, bias = weights[bAt + out];
    let row = 0;
    for (; row + 3 < rows; row += 4) {
      const r0 = row * width, r1 = r0 + width, r2 = r1 + width, r3 = r2 + width;
      let s0 = bias, s1 = bias, s2 = bias, s3 = bias;
      for (let j = 0; j < width; j++) {
        const w = weights[at + j];
        s0 += w * input[r0 + j]; s1 += w * input[r1 + j];
        s2 += w * input[r2 + j]; s3 += w * input[r3 + j];
      }
      if (relu) { s0 = s0 > 0 ? s0 : 0; s1 = s1 > 0 ? s1 : 0; s2 = s2 > 0 ? s2 : 0; s3 = s3 > 0 ? s3 : 0; }
      const o0 = row * outputs + out, o1 = o0 + outputs, o2 = o1 + outputs, o3 = o2 + outputs;
      result[o0] = s0 + (residual ? residual[o0] : 0);
      result[o1] = s1 + (residual ? residual[o1] : 0);
      result[o2] = s2 + (residual ? residual[o2] : 0);
      result[o3] = s3 + (residual ? residual[o3] : 0);
    }
    for (; row < rows; row++) {
      const base = row * width, target = row * outputs + out;
      let sum = bias;
      for (let j = 0; j < width; j++) sum += weights[at + j] * input[base + j];
      if (relu) sum = sum > 0 ? sum : 0;
      result[target] = sum + (residual ? residual[target] : 0);
    }
  }
  return result;
}

/** [{position: FastPosition, actions: numeric[]}], at most 32 immutable inputs. */
export function batchPolicyValue(requests, temperature = 1) {
  if (!Array.isArray(requests)) throw new TypeError('Policy/value batch must be an array');
  if (requests.length > 32) throw new RangeError('Policy/value batch exceeds 32 positions');
  if (!requests.length) return [];
  if (!Number.isFinite(temperature) || temperature <= 0) throw new RangeError('Policy temperature must be positive and finite');
  const rows = requests.length, h1 = new Float64Array(rows * H);
  const logits = requests.map(request => new Float64Array(request.actions.length));
  const policyRows = Array.from({ length: N_POLICY }, () => []);
  for (let row = 0; row < rows; row++) {
    const { position: p, actions } = requests[row];
    const base = row * H, encoded = { b: Int8Array.from(p.board, piece => piece > 8 ? piece - 3 : piece), h: p.hands, t: p.turn };
    for (let j = 0; j < H; j++) h1[base + j] = weights[LAYOUT.b1 + j];
    for (const feature of features(encoded, p.counts.get(p.key()) || 0)) {
      const at = LAYOUT.w1 + feature * H;
      for (let j = 0; j < H; j++) h1[base + j] += weights[at + j];
    }
    for (let j = 0; j < H; j++) if (h1[base + j] < 0) h1[base + j] = 0;
    for (let slot = 0; slot < actions.length; slot++) {
      const action = actions[slot];
      if (!Number.isInteger(action) || action < 0 || action >= N_POLICY) throw new RangeError('Invalid batched policy action');
      policyRows[canonAction(action, p.turn)].push({ row, slot });
    }
  }
  const h2 = dense(h1, H, H, LAYOUT.w2, LAYOUT.b2, rows, true, h1);
  const h3 = dense(h2, H, H, LAYOUT.w3, LAYOUT.b3, rows, true, h2);
  const hv = dense(h3, H, VH, LAYOUT.v1, LAYOUT.vb1, rows, true);
  const raw = dense(hv, VH, 1, LAYOUT.v2, LAYOUT.vb2, rows, false);

  // Compute only requested legal logits. Grouping by canonical action shares
  // that policy column across rows without paying for all 180 logits per row.
  for (let action = 0; action < N_POLICY; action++) {
    const entries = policyRows[action], at = LAYOUT.p + action * H, bias = weights[LAYOUT.pb + action];
    let item = 0;
    for (; item + 3 < entries.length; item += 4) {
      const e0 = entries[item], e1 = entries[item + 1], e2 = entries[item + 2], e3 = entries[item + 3];
      const r0 = e0.row * H, r1 = e1.row * H, r2 = e2.row * H, r3 = e3.row * H;
      let s0 = bias, s1 = bias, s2 = bias, s3 = bias;
      for (let j = 0; j < H; j++) {
        const w = weights[at + j];
        s0 += w * h3[r0 + j]; s1 += w * h3[r1 + j]; s2 += w * h3[r2 + j]; s3 += w * h3[r3 + j];
      }
      logits[e0.row][e0.slot] = s0; logits[e1.row][e1.slot] = s1;
      logits[e2.row][e2.slot] = s2; logits[e3.row][e3.slot] = s3;
    }
    for (; item < entries.length; item++) {
      const { row, slot } = entries[item], base = row * H;
      let sum = bias;
      for (let j = 0; j < H; j++) sum += weights[at + j] * h3[base + j];
      logits[row][slot] = sum;
    }
  }
  return requests.map((_, row) => {
    const value = Math.tanh(raw[row]), rowLogits = logits[row], prior = new Float64Array(rowLogits.length);
    const top = Math.max(...rowLogits);
    let total = 0;
    for (let i = 0; i < prior.length; i++) total += prior[i] = Math.exp((rowLogits[i] - top) / temperature);
    for (let i = 0; i < prior.length; i++) prior[i] /= total;
    if (!Number.isFinite(value) || !prior.every(Number.isFinite)) throw new Error('Invalid batched neural output');
    return { value, prior };
  });
}
