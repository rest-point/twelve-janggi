import { readFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadRegistry, sha256 } from '../bench/common.mjs';
import { playGame } from '../bench/referee.mjs';
import { verifyGame } from '../bench/replay.mjs';
import { replaySteps } from '../src/record-replay.js';
import { legalActions, positionKey } from '../src/engine.js';
import { writeJsonAtomic } from './lib/atomic-json.mjs';

const directory = path.join(ROOT, 'artifacts', 'winrate-campaign', '2026-11-08');
await mkdir(directory, { recursive: true });
const stateFile = path.join(directory, 'deviations.json'), recordsFile = path.join(directory, 'deviation-games.jsonl');
const control = JSON.parse(await readFile(path.join(directory, 'control.json'), 'utf8'));
const baseGames = (await readFile(path.join(ROOT, 'artifacts', control.results[0].runId, 'games.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const baseline = baseGames.find(g => g.first === 0 && g.aSide === 0);
verifyGame(baseline);
const target = (await loadRegistry()).find(m => m.id === 'azero-v2');
const entryPath = fileURLToPath(new URL('../models/lab-deviation-probe.mjs', import.meta.url));
const sourceHash = sha256(await readFile(entryPath));
const frames = [...replaySteps(baseline)];
const priority = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 2, 3, 4, 5, 6, 7, 18, 19, 20, 21, 22, 23, 24];
const tasks = [];
for (const ply of priority) {
  const state = frames[ply]?.state;
  if (!state || state.winner !== null) continue;
  const selected = baseline.moves[ply]?.action;
  for (const action of legalActions(state)) {
    if (JSON.stringify(action) === JSON.stringify(selected)) continue;
    tasks.push({ id: tasks.length, key: `${ply}:${JSON.stringify(action)}`, ply, action, state,
      opening: baseline.moves.slice(0, ply).map(m => m.action) });
  }
}
const settings = { baselineRun: control.results[0].runId, targetHash: target.artifactHash, probeSourceHash: sourceHash,
  taskKeys: tasks.map(t => t.key), maxTrials: Math.min(160, tasks.length), concurrency: 2, moveMs: 60000, absoluteMaxPly: 256, seed: 20261108 };
const fingerprint = sha256(JSON.stringify(settings));
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (state && state.fingerprint !== fingerprint) throw new Error('Probe inputs changed; preserve this campaign and use a new version');
state ||= { fingerprint, settings, startedAt: new Date().toISOString(), results: [], wins: {} };
state.status = 'running';
const done = new Set(state.results.map(r => r.key));
let next = 0, allocated = state.results.length, writes = Promise.resolve();
function persist(game) {
  const snapshot = structuredClone(state);
  writes = writes.then(async () => {
    if (game) await appendFile(recordsFile, JSON.stringify(game) + '\n');
    await writeJsonAtomic(stateFile, snapshot);
  });
  return writes;
}
await persist();
async function work() {
  for (;;) {
    if (Object.keys(state.wins).length === 2 || allocated >= settings.maxTrials) return;
    let task;
    while (next < tasks.length) {
      const candidate = tasks[next++];
      if (!done.has(candidate.key) && !state.wins[candidate.state.turn]) { task = candidate; break; }
    }
    if (!task) return;
    allocated++;
    const config = { sims: 800, probePly: task.ply, positionKey: positionKey(task.state), historyKey: JSON.stringify(task.state.positions), action: task.action };
    const probe = { id: `probe-p${task.ply}-a${task.id}-v1`, entryPath, config };
    const artifactHash = sha256(JSON.stringify({ sourceHash, fallbackHash: target.artifactHash, config }));
    const job = { index: task.id, first: 0, aSide: task.state.turn, pairId: `probe-${task.id}`,
      opening: task.opening, startState: structuredClone(task.state) };
    console.log(`Probe ${task.id}: own side ${job.aSide}, ply ${task.ply}, ${JSON.stringify(task.action)}`);
    const game = await playGame(job, [probe, target], { moveMs: settings.moveMs, maxPlies: 256 - task.ply, seed: settings.seed });
    game.runId = 'deviation-probe-v1'; game.configHash = fingerprint;
    game.probe = { key: task.key, artifactHash, config, targetId: target.id, targetHash: target.artifactHash };
    verifyGame(game);
    const failure = ['model-error', 'model-timeout', 'invalid-response', 'illegal-action'].includes(game.termination);
    const result = game.winner === 'draw' ? 'draw' : game.winner === job.aSide ? 'win' : 'loss';
    const summary = { key: task.key, index: task.id, side: job.aSide, probePly: task.ply, action: task.action,
      result, termination: game.termination, finalPly: game.finalPly, modelFailure: failure, artifactHash };
    state.results.push(summary); done.add(task.key);
    if (result === 'win' && !failure && !state.wins[job.aSide]) state.wins[job.aSide] = {
      ...summary, state: task.state, opening: task.opening, winningContinuation: game.moves.map(m => m.action) };
    console.log(`Verified ${state.results.length}/${settings.maxTrials}: ${result}, ${game.termination}, final ply ${game.finalPly}`);
    await persist(game);
  }
}
try {
  await Promise.all([work(), work()]);
  state.status = 'completed'; state.finishedAt = new Date().toISOString();
  await persist();
} catch (error) {
  state.status = 'interrupted'; state.error = error.message;
  await persist();
  throw error;
}
console.log(JSON.stringify({ results: state.results.length, wins: Object.keys(state.wins), output: stateFile }, null, 2));
