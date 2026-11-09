import { readFileSync } from 'node:fs';
import { searchBatch } from './packed-puct-search-v2.mjs';
import { createPackedEvaluator } from './packed-gemm-policy-value-v2.mjs';

const bytes = readFileSync(new URL('./packed-gemm-puct-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const evaluate = createPackedEvaluator(weights);

export function think(request) {
  const { action, info } = searchBatch(request, evaluate);
  return { action, info };
}
