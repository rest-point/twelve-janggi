import { readFileSync } from 'node:fs';
import { fromEngine, historyFromEngine, search, toEngineAction } from './azero-core.mjs';

const weights = new Float32Array(readFileSync(new URL('./azero-v1.bin', import.meta.url)).buffer.slice(0));
export function think({ state, config }) {
  const started = performance.now();
  const root = search(fromEngine(state), historyFromEngine(state), weights, { sims: config.sims });
  const action = toEngineAction(root.acts[root.N.indexOf(Math.max(...root.N))]);
  return { action, info: { nodes: config.sims, searchMs: performance.now() - started } };
}
