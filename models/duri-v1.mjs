import { readFileSync } from 'node:fs';
import { LAYOUT } from './azero-core.mjs';
import { search } from './soljang-search-v1.mjs';

// Duri deliberately uses only the original v1 network, never the v2 weights.
const bytes = readFileSync(new URL('./azero-v1.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
if (weights.length !== LAYOUT.size || !weights.every(Number.isFinite)) throw new Error('Invalid Duri weights');

export function analyze(request) { return search(request, weights); }
export function think(request) {
  const { action, info } = analyze(request);
  return { action, info };
}
