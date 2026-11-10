import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { features, canonAction, LAYOUT, forward } from './azero-core.mjs';
import { solveWin } from './dfpn-proof-v1.mjs';
import { openFullTablebase } from './full-tablebase-v2.mjs';
import { analyze } from './team-contender-search-v2.mjs';

const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
if (bytes.byteLength !== LAYOUT.size * Float32Array.BYTES_PER_ELEMENT) throw new Error('Invalid AlphaZero v2 weights');
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
if (!weights.every(Number.isFinite)) throw new Error('Invalid AlphaZero v2 weights');
const tablebase = openFullTablebase();

function scorePolicyValue(position, legalMoveCodes, seenCount) {
  const encoded = {
    b: Int8Array.from(position.board, piece => piece > 8 ? piece - 3 : piece),
    h: position.hands,
    t: position.turn,
  };
  const logits = new Float64Array(legalMoveCodes.length);
  const value = forward(weights, features(encoded, seenCount),
    legalMoveCodes.map(move => canonAction(move, position.turn)), logits);
  return { value: Math.round(Math.tanh(value) * 10000), priors: logits };
}

export function think(request) {
  const started = performance.now(), config = request?.config || {};
  const budgetMs = Number.isFinite(request?.budgetMs) ? Math.max(0, request.budgetMs) : 60000;
  const maxTimeMs = Number.isFinite(config.maxTimeMs) ? Math.max(0, config.maxTimeMs) : 360;
  const tablebaseMaxMs = Number.isFinite(config.tablebaseMaxMs) ? Math.max(0, config.tablebaseMaxMs) : 32;
  const tablebaseDeadline = started + Math.min(budgetMs, maxTimeMs, tablebaseMaxMs);
  const services = {
    tablebase: {
      probe(position) { return performance.now() <= tablebaseDeadline ? tablebase.probe(position) : 0; },
      probeKey(key) { return performance.now() <= tablebaseDeadline ? tablebase.probeKey(key) : 0; },
    },
    scorePolicyValue,
    proveWin: solveWin,
    now: () => performance.now(),
  };
  const result = analyze(request, services);
  return { action: result.action, info: {
    nodes: result.info.nodes,
    completedDepth: result.info.completedDepth,
    searchMs: result.info.searchMs,
  } };
}
