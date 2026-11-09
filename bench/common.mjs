import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, legalActions, applyAction, RULESET } from '../src/engine.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function seedOf(...parts) {
  return parseInt(sha256(JSON.stringify(parts)).slice(0, 8), 16) >>> 0;
}
export function rng(seed) {
  let n = seed >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
}
export async function loadRegistry() {
  const base = await realpath(path.join(ROOT, 'models'));
  const entries = JSON.parse(await readFile(path.join(base, 'registry.json'), 'utf8'));
  if (!Array.isArray(entries) || !entries.length) throw new Error('Registry must be a nonempty array');
  const ids = new Set(), result = [];
  for (const manifest of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id) || ids.has(manifest.id)) throw new Error('Invalid/duplicate model ID');
    ids.add(manifest.id);
    if (manifest.protocol !== 'js-v1' || manifest.ruleset !== RULESET || typeof manifest.version !== 'string' || !manifest.version || !manifest.config || typeof manifest.config !== 'object' || Array.isArray(manifest.config) || !Array.isArray(manifest.files)) throw new Error(`Invalid manifest: ${manifest.id}`);
    const digests = {};
    let entryPath;
    for (const file of [manifest.entry, ...manifest.files]) {
      if (typeof file !== 'string' || path.isAbsolute(file)) throw new Error('Model file must be relative');
      const actual = await realpath(path.resolve(base, file));
      if (!actual.startsWith(base + path.sep) || !(await stat(actual)).isFile()) throw new Error('Model file escapes models directory');
      digests[file] = sha256(await readFile(actual));
      if (file === manifest.entry) entryPath = actual;
    }
    result.push({ ...manifest, entryPath, digests, artifactHash: sha256(JSON.stringify({ manifest, digests })) });
  }
  return result;
}
export const BLUE_FIRST_POLICY = 'blue-first-v1';

export function makeJob(index, options) {
  const blockId = Math.floor(index / 4);
  if (options.startPolicy === 'initial-alternating-v1') {
    // Alternate the model that starts every game. Swap colours every pair so
    // both models also receive each colour/initial-turn combination equally.
    const aSide = Math.floor(index / 2) % 2;
    const first = index % 2 === 0 ? aSide : 1 - aSide;
    return { index, blockId, pairId: `${blockId}:${aSide}`, first, aSide, opening: [], startState: initialState(first) };
  }
  const pair = Math.floor((index % 4) / 2);
  // Older archived runs omit the policy and used the pair to choose the starter.
  const first = options.startPolicy === BLUE_FIRST_POLICY ? 0 : pair;
  const aSide = index % 2;
  let state = initialState(first);
  const random = rng(seedOf(options.seed, blockId, pair, 'opening'));
  const opening = [];
  for (let ply = 0; ply < options.openingPlies; ply++) {
    const candidates = legalActions(state);
    const start = Math.floor(random() * candidates.length);
    let selected;
    for (let offset = 0; offset < candidates.length; offset++) {
      const action = candidates[(start + offset) % candidates.length];
      const next = applyAction(state, action, false);
      if (next.winner === null) { selected = action; state = next; break; }
    }
    if (!selected) break;
    opening.push(selected);
  }
  return { index, blockId, pairId: `${blockId}:${pair}`, first, aSide, opening, startState: state };
}
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export function summarize(games, wallMs) {
  const total = { wins: 0, draws: 0, losses: 0 };
  const byColor = [0, 1].map(side => ({ side, wins: 0, draws: 0, losses: 0 }));
  const byFirst = [true, false].map(aInitiallyFirst => ({ aInitiallyFirst, wins: 0, draws: 0, losses: 0 }));
  const reasons = {}, times = { a: [], b: [] }, startup = { a: [], b: [] };
  const modelFailureCounts = { a: 0, b: 0 };
  for (const game of games) {
    const key = game.winner === 'draw' ? 'draws' : game.winner === game.aSide ? 'wins' : 'losses';
    total[key]++; byColor[game.aSide][key]++; byFirst[game.first === game.aSide ? 0 : 1][key]++;
    reasons[game.termination] = (reasons[game.termination] || 0) + 1;
    if (['model-error', 'model-timeout', 'invalid-response', 'illegal-action'].includes(game.termination)) modelFailureCounts[game.winner === game.aSide ? 'b' : 'a']++;
    for (const move of game.moves) times[move.side === game.aSide ? 'a' : 'b'].push(move.elapsedMs);
    for (const attempt of game.attempts) if (!attempt.accepted) times[attempt.side === game.aSide ? 'a' : 'b'].push(attempt.elapsedMs);
    for (const item of game.startups) startup[item.side === game.aSide ? 'a' : 'b'].push(item.elapsedMs);
  }
  const modelFailures = Object.entries(reasons).filter(([r]) => ['model-error', 'model-timeout', 'invalid-response', 'illegal-action'].includes(r)).reduce((n, [, count]) => n + count, 0);
  return { games: games.length, ...total, winRate: total.wins / games.length, scoreRate: (total.wins + total.draws / 2) / games.length,
    byAColor: byColor, byAFirst: byFirst,
    reasons, modelFailures, modelFailureCounts, modelFailureRate: modelFailures / games.length,
    uniqueOpenings: new Set(games.map(g => g.openingKey)).size,
    timing: Object.fromEntries(['a', 'b'].map(k => [k, { count: times[k].length, p50Ms: percentile(times[k], 0.5), p95Ms: percentile(times[k], 0.95), maxMs: times[k].length ? times[k].reduce((max, n) => Math.max(max, n), 0) : null, startupP95Ms: percentile(startup[k], 0.95) }])),
    wallMs, gamesPerSecond: games.length / (wallMs / 1000), confidenceInterval: null,
  };
}
