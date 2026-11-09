import { readFileSync } from 'node:fs';
import { features, canonAction, forward, LAYOUT } from './azero-core.mjs';

// Reuse the existing TWELVE-JANGGI weights, not a missing shogi ONNX model.
// Only neural features/inference are reused; azero search/rules are not called.
const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
if (bytes.byteLength !== LAYOUT.size * 4) throw new Error('Invalid policy/value weight length');
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
if (!weights.every(Number.isFinite)) throw new Error('Nonfinite policy/value weights');

/** Immutable probabilities in canonical legal-action order; value for mover. */
export function policyValue(position, actions, temperature = 1) {
  const b = Int8Array.from(position.board, c => c > 8 ? c - 3 : c);
  const s = { b, h: position.hands, t: position.turn };
  const repetitions = position.counts.get(position.key()) || 0;
  const logits = new Float64Array(actions.length);
  const value = Math.tanh(forward(weights, features(s, repetitions), actions.map(a => canonAction(a, s.t)), logits));
  const top = Math.max(...logits), prior = new Float64Array(actions.length);
  let total = 0;
  for (let i = 0; i < prior.length; i++) total += prior[i] = Math.exp((logits[i] - top) / temperature);
  for (let i = 0; i < prior.length; i++) prior[i] /= total;
  if (!Number.isFinite(value) || !prior.every(Number.isFinite)) throw new Error('Invalid neural output');
  return { value, prior };
}
