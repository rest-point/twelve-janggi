import { readFileSync } from 'node:fs';
import { fromEngine, historyFromEngine, search, toEngineAction } from './azero-core.mjs';

// Original v2 weights remain immutable. Only search settings vary in this lab.
const bytes = readFileSync(new URL('./azero-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
export function think({ state, legalActions, config = {} }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No live legal actions');
  const { sims, cpuct } = config;
  if (!Number.isInteger(sims) || sims < 1 || sims > 8000 || !Number.isFinite(cpuct) || cpuct < 0.1 || cpuct > 4) throw new Error('Invalid search settings');
  const started = performance.now();
  const root = search(fromEngine(state), historyFromEngine(state), weights, { sims, cpuct });
  const action = toEngineAction(root.acts[root.N.indexOf(Math.max(...root.N))]);
  return { action, info: { nodes: sims, searchMs: performance.now() - started } };
}
