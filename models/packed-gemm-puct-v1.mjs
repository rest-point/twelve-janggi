import { searchBatch } from './batch-puct-dfpn-v1.mjs';
import { packedBatchPolicyValue } from './packed-gemm-policy-value-v1.mjs';

// The rules, proof search and reservation cleanup are the immutable, tested
// batched searcher. Only the neural execution kernel changes for this model.
// This is JavaScript CPU inference, not TensorRT/CUDA/GPU execution.
export function think(request) {
  const { action, info } = searchBatch(request, packedBatchPolicyValue);
  return { action, info };
}
