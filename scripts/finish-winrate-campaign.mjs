import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadRegistry } from '../bench/common.mjs';
import { runNode } from './lib/run-node.mjs';
import { writeJsonAtomic } from './lib/atomic-json.mjs';

const directory = path.join(ROOT, 'artifacts', 'winrate-campaign', '2026-11-08');
const read = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const chosen = await read('selected-candidate.json'), decision = await read('decision.json');
const candidate = chosen.artifact.id, target = decision.target.id;
const tasks = [
  { stage: 'holdout-baseline', a: decision.baselineChallenger.id, b: target, games: 12, opening: 4, seed: 20261201 },
  { stage: 'holdout-candidate', a: candidate, b: target, games: 12, opening: 4, seed: 20261201 },
  { stage: 'regression-azero1', a: candidate, b: 'azero-v1', games: 4, opening: 0, seed: 20261202 },
  { stage: 'regression-stockjang', a: candidate, b: 'stockjang-v1', games: 4, opening: 0, seed: 20261203 },
];
let status = { candidate, target, tasks, status: 'waiting-for-web-confirmation', completed: [], startedAt: new Date().toISOString() };
try {
  const previous = await read('followup.json');
  if (previous.candidate !== candidate || previous.target !== target) throw new Error('Campaign target changed');
  status = { ...previous, status: 'waiting-for-web-confirmation' };
} catch (error) { if (error.code !== 'ENOENT') throw error; }
async function verifyFrozen() {
  const models = await loadRegistry();
  for (const [id, hash] of [[candidate, chosen.artifact.artifactHash], [target, decision.target.artifactHash]])
    if (models.find(m => m.id === id)?.artifactHash !== hash) throw new Error('Frozen artifact changed: ' + id);
}
await verifyFrozen();
await writeJsonAtomic(path.join(directory, 'followup.json'), status);
console.log('Waiting for the official web batch to finish and pass all 100 replay checks.');
for (;;) {
  const web = await read('web-final-confirmation.json');
  if (web.a !== candidate || web.b !== target) throw new Error('Unexpected web confirmation pair');
  if (web.status === 'completed') break;
  if (web.progress?.status === 'error') throw new Error('Web batch has incomplete infrastructure jobs');
  await new Promise(resolve => setTimeout(resolve, 15000));
}
try {
  await verifyFrozen();
  status.status = 'running'; await writeJsonAtomic(path.join(directory, 'followup.json'), status);
  for (const task of tasks) {
    console.log('Follow-up: ' + task.stage);
    await runNode(['scripts/winrate-campaign.mjs', '--stage', task.stage, '--a', task.a, '--b', task.b,
      '--games', String(task.games), '--opening-plies', String(task.opening), '--seed', String(task.seed)]);
    if (!status.completed.includes(task.stage)) status.completed.push(task.stage);
    await writeJsonAtomic(path.join(directory, 'followup.json'), status);
  }
  await verifyFrozen();
  status.status = 'completed'; status.finishedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(directory, 'followup.json'), status);
  console.log('Official web verification, paired holdout and regression runs completed.');
} catch (error) {
  status.status = 'interrupted'; status.error = error.message;
  await writeJsonAtomic(path.join(directory, 'followup.json'), status);
  throw error;
}
