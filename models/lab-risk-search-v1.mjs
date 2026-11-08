import { readFileSync } from 'node:fs';
import { fromEngine, historyFromEngine, toEngineAction } from './azero-core.mjs';
import { search } from './lab-risk-core-v1.mjs';
const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
export function think({ state, legalActions, config = {} }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No live legal actions');
  const { sims, cpuct, contempt } = config;
  if (!Number.isInteger(sims) || sims < 1 || sims > 8000 || !Number.isFinite(cpuct) || cpuct < 0.1 || cpuct > 4
    || !Number.isFinite(contempt) || contempt < 0 || contempt > 0.9) throw new Error('Invalid search settings');
  const started = performance.now();
  const root = search(fromEngine(state), historyFromEngine(state), weights, { sims, cpuct, contempt });
  return { action: toEngineAction(root.acts[root.N.indexOf(Math.max(...root.N))]),
    info: { nodes: sims, searchMs: performance.now() - started } };
}
