// TB-RL v2 (five RL rounds, off-policy corrected): full-tablebase safety + 2-ply repetition avoidance + a league-trained
// value network that picks, among proven-safe moves, the one most likely to make
// the opponent eventually step into a lost position.
// Cost per move: one tablebase probe per legal move (+ one per opponent reply of
// each safe candidate when config.trap) and one tiny MLP evaluation per safe
// candidate -- typically about a millisecond.
import { readFileSync } from 'node:fs';
import { FEATURES, TRAP, openTable, classify, safeCandidates, createMlp, candidateInput, rng } from './tbrl-core.mjs';

const table = openTable();
const bytes = readFileSync(new URL('./tbrl-v2.bin', import.meta.url));
const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const networks = new Map();
function network(config) {
  const hidden = config.hidden ?? [128, 64], trap = !!config.trap, key = `${hidden}|${trap}`;
  if (!networks.has(key)) networks.set(key, createMlp(weights, hidden, trap ? FEATURES + TRAP : FEATURES));
  return { value: networks.get(key), trap };
}

export function analyze({ state, legalActions, seed, config = {} }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now(), misses = table.misses;
  const { value, trap } = network(config);
  const { tier, eligible } = safeCandidates(classify(state, legalActions, table));
  let child = eligible[0], source = tier === 1 ? 'tablebase-win' : 'forced';
  if (eligible.length > 1) {
    const random = rng(seed);
    let best = -Infinity;
    for (const c of eligible) {
      c.score = value(candidateInput(state, c, table, trap)) + 1e-6 * random(); // seeded tie-break only
      if (c.score > best) { best = c.score; child = c; }
    }
    source = 'value';
  }
  return { action: child.action, source, tier, eligible,
    info: { nodes: legalActions.length + table.misses - misses, searchMs: performance.now() - started } };
}

export function think(request) {
  const { action, info } = analyze(request);
  return { action, info };
}
