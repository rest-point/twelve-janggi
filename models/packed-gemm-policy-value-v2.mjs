import { features, canonAction, LAYOUT, H, VH, N_POLICY } from './azero-core.mjs';

// CPU packed/tiled GEMM for the trained twelve-janggi MLP.
// TensorRT, CUDA, ONNX Runtime, DirectML and GPU execution are not used.
// Versioned factory so a worker can compile one immutable checkpoint per round.
export function createPackedEvaluator(weights, cacheSize = 8192) {
  if (!(weights instanceof Float32Array) || weights.length !== LAYOUT.size || !weights.every(Number.isFinite)) {
    throw new Error('Invalid policy/value checkpoint');
  }
  // Exact widening preserves the trained FP32 values without quantization.
  // Output tiles are [out0[j],out1[j],out2[j],out3[j]] for each input j.
  function packLayer(wAt, bAt, width, outputs) {
    const data = new Float64Array(width * outputs);
    for (let out = 0; out < outputs; out += 4) for (let j = 0; j < width; j++) {
      for (let lane = 0; lane < 4; lane++) data[out * width + j * 4 + lane] = weights[wAt + (out + lane) * width + j];
    }
    return { data, bias: Float64Array.from(weights.subarray(bAt, bAt + outputs)), width, outputs };
  }
  const SECOND = packLayer(LAYOUT.w2, LAYOUT.b2, H, H);
  const THIRD = packLayer(LAYOUT.w3, LAYOUT.b3, H, H);
  const VALUE = packLayer(LAYOUT.v1, LAYOUT.vb1, H, VH);

  function valueHead(input, rows) {
    const result = new Float64Array(rows);
    for (let row = 0; row < rows; row++) {
      let sum = weights[LAYOUT.vb2];
      for (let j = 0; j < VH; j++) sum += weights[LAYOUT.v2 + j] * input[row * VH + j];
      result[row] = sum;
    }
    return result;
  }

  // Fixed CPU 4-row by 4-output tile, with fused bias/ReLU/residual.
  function packedGemm(input, layer, rows, residual = null) {
    const { data, bias, width, outputs } = layer;
    const result = new Float64Array(rows * outputs);
    for (let out = 0; out < outputs; out += 4) {
      const at = out * width;
      let row = 0;
      for (; row + 3 < rows; row += 4) {
        const r0 = (row + 0) * width, o0 = (row + 0) * outputs + out;
        const r1 = (row + 1) * width, o1 = (row + 1) * outputs + out;
        const r2 = (row + 2) * width, o2 = (row + 2) * outputs + out;
        const r3 = (row + 3) * width, o3 = (row + 3) * outputs + out;
        let s00 = bias[out + 0], s01 = bias[out + 1], s02 = bias[out + 2], s03 = bias[out + 3];
        let s10 = bias[out + 0], s11 = bias[out + 1], s12 = bias[out + 2], s13 = bias[out + 3];
        let s20 = bias[out + 0], s21 = bias[out + 1], s22 = bias[out + 2], s23 = bias[out + 3];
        let s30 = bias[out + 0], s31 = bias[out + 1], s32 = bias[out + 2], s33 = bias[out + 3];
        for (let j = 0; j < width; j++) {
          const w = at + j * 4;
          const w0 = data[w], w1 = data[w + 1], w2 = data[w + 2], w3 = data[w + 3];
          const x0 = input[r0 + j];
          s00 += w0 * x0; s01 += w1 * x0; s02 += w2 * x0; s03 += w3 * x0;
          const x1 = input[r1 + j];
          s10 += w0 * x1; s11 += w1 * x1; s12 += w2 * x1; s13 += w3 * x1;
          const x2 = input[r2 + j];
          s20 += w0 * x2; s21 += w1 * x2; s22 += w2 * x2; s23 += w3 * x2;
          const x3 = input[r3 + j];
          s30 += w0 * x3; s31 += w1 * x3; s32 += w2 * x3; s33 += w3 * x3;
        }
        result[o0 + 0] = (s00 > 0 ? s00 : 0) + (residual ? residual[o0 + 0] : 0);
        result[o0 + 1] = (s01 > 0 ? s01 : 0) + (residual ? residual[o0 + 1] : 0);
        result[o0 + 2] = (s02 > 0 ? s02 : 0) + (residual ? residual[o0 + 2] : 0);
        result[o0 + 3] = (s03 > 0 ? s03 : 0) + (residual ? residual[o0 + 3] : 0);
        result[o1 + 0] = (s10 > 0 ? s10 : 0) + (residual ? residual[o1 + 0] : 0);
        result[o1 + 1] = (s11 > 0 ? s11 : 0) + (residual ? residual[o1 + 1] : 0);
        result[o1 + 2] = (s12 > 0 ? s12 : 0) + (residual ? residual[o1 + 2] : 0);
        result[o1 + 3] = (s13 > 0 ? s13 : 0) + (residual ? residual[o1 + 3] : 0);
        result[o2 + 0] = (s20 > 0 ? s20 : 0) + (residual ? residual[o2 + 0] : 0);
        result[o2 + 1] = (s21 > 0 ? s21 : 0) + (residual ? residual[o2 + 1] : 0);
        result[o2 + 2] = (s22 > 0 ? s22 : 0) + (residual ? residual[o2 + 2] : 0);
        result[o2 + 3] = (s23 > 0 ? s23 : 0) + (residual ? residual[o2 + 3] : 0);
        result[o3 + 0] = (s30 > 0 ? s30 : 0) + (residual ? residual[o3 + 0] : 0);
        result[o3 + 1] = (s31 > 0 ? s31 : 0) + (residual ? residual[o3 + 1] : 0);
        result[o3 + 2] = (s32 > 0 ? s32 : 0) + (residual ? residual[o3 + 2] : 0);
        result[o3 + 3] = (s33 > 0 ? s33 : 0) + (residual ? residual[o3 + 3] : 0);
      }
      for (; row < rows; row++) {
        const r0 = (row + 0) * width, o0 = (row + 0) * outputs + out;
        let s00 = bias[out + 0], s01 = bias[out + 1], s02 = bias[out + 2], s03 = bias[out + 3];
        for (let j = 0; j < width; j++) {
          const w = at + j * 4;
          const w0 = data[w], w1 = data[w + 1], w2 = data[w + 2], w3 = data[w + 3];
          const x0 = input[r0 + j];
          s00 += w0 * x0; s01 += w1 * x0; s02 += w2 * x0; s03 += w3 * x0;
        }
        result[o0 + 0] = (s00 > 0 ? s00 : 0) + (residual ? residual[o0 + 0] : 0);
        result[o0 + 1] = (s01 > 0 ? s01 : 0) + (residual ? residual[o0 + 1] : 0);
        result[o0 + 2] = (s02 > 0 ? s02 : 0) + (residual ? residual[o0 + 2] : 0);
        result[o0 + 3] = (s03 > 0 ? s03 : 0) + (residual ? residual[o0 + 3] : 0);
      }
    }
    return result;
  }

  /** [{position: FastPosition, actions: numeric[]}], at most 32 immutable inputs. */
  function evaluateBatch(requests, temperature = 1) {
    if (!Array.isArray(requests)) throw new TypeError('Packed policy/value batch must be an array');
    if (requests.length > 32) throw new RangeError('Packed policy/value batch exceeds 32 positions');
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
        if (!Number.isInteger(action) || action < 0 || action >= N_POLICY) throw new RangeError('Invalid packed policy action');
        policyRows[canonAction(action, p.turn)].push({ row, slot });
      }
    }
    const h2 = packedGemm(h1, SECOND, rows, h1);
    const h3 = packedGemm(h2, THIRD, rows, h2);
    const hv = packedGemm(h3, VALUE, rows);
    const raw = valueHead(hv, rows);

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
      if (!Number.isFinite(value) || !prior.every(Number.isFinite)) throw new Error('Invalid packed neural output');
      return { value, prior };
    });
  }

  // Only memoize network outputs. The rule engine and search still keep the
  // entire repetition history and a fresh tree for each request.
  const cache = new Map();
  return (requests, temperature = 1) => {
    if (!Array.isArray(requests) || requests.length > 32) throw new Error('Expected at most 32 positions');
    if (!cacheSize) return evaluateBatch(requests, temperature);
    const misses = [], indices = [], keys = [];
    const predictions = requests.map((request, index) => {
      const { position, actions } = request;
      const key = position.key();
      const signature = JSON.stringify([key, position.counts.get(key) ?? 1, actions, temperature]);
      const cached = cache.get(signature);
      if (cached) return cached;
      misses.push(request);
      indices.push(index);
      keys.push(signature);
      return null;
    });
    const fresh = evaluateBatch(misses, temperature);
    for (let i = 0; i < fresh.length; i++) {
      if (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
      cache.set(keys[i], fresh[i]);
      predictions[indices[i]] = fresh[i];
    }
    return predictions;
  };
}
