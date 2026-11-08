import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../bench/common.mjs';
import { replaySteps } from '../src/record-replay.js';
import { writeJsonAtomic } from './lib/atomic-json.mjs';

const [a, b, label = 'confirmation'] = process.argv.slice(2);
if (!a || !b || a === b || !/^[a-z0-9-]+$/.test(label)) throw new Error('Usage: node scripts/winrate-web.mjs model-a model-b label');
const origin = 'http://127.0.0.1:3000';
const directory = path.join(ROOT, 'artifacts', 'winrate-campaign', '2026-11-08');
await mkdir(directory, { recursive: true });
const filename = path.join(directory, 'web-' + label + '.json');
let checkpoint;
try { checkpoint = JSON.parse(await readFile(filename, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (checkpoint && (checkpoint.a !== a || checkpoint.b !== b)) throw new Error('Label belongs to a different pair');
checkpoint ||= { a, b, requestId: randomUUID(), startedAt: new Date().toISOString(), status: 'preparing' };
async function save() {
  await writeJsonAtomic(filename, checkpoint);
}
let session;
const sessionFile = path.join(ROOT, 'data', 'winrate-client-session.json');
try { session = JSON.parse(await readFile(sessionFile, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
session ||= {};
async function call(route, method = 'GET', body) {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(30000),
    headers: { ...(session.cookie ? { Cookie: session.cookie } : {}), ...(method === 'POST'
      ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf || '' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  const cookies = response.headers.getSetCookie();
  if (cookies.length) session.cookie = cookies.map(v => v.split(';')[0]).join('; ');
  if (data.csrfToken) session.csrf = data.csrfToken;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const me = await call('/api/me');
if (!me.guest) await call('/api/guest/session', 'POST', { name: '승률 실험' });
await mkdir(path.dirname(sessionFile), { recursive: true });
await writeFile(sessionFile, JSON.stringify(session));
const catalog = (await call('/api/models')).models;
const actual = id => {
  const model = catalog.find(m => (m.registryId || m.id) === id);
  if (!model) throw new Error('Model not loaded in server: ' + id);
  return model.id;
};
if (!checkpoint.seriesId) {
  // The stable request ID makes uncertain HTTP retries idempotent.
  await save();
  const submitted = await call('/api/model-matches', 'POST', { modelA: actual(a), modelB: actual(b), requestId: checkpoint.requestId });
  checkpoint.seriesId = submitted.id;
  checkpoint.batchId = submitted.batchId;
  checkpoint.modelVersions = { a: actual(a), b: actual(b) };
  checkpoint.url = `${origin}/experiments?run=${submitted.id}`;
  checkpoint.status = 'running';
  await save();
}
console.log('Web batch: ' + checkpoint.url);
let detail, previous = '';
for (;;) {
  detail = await call('/api/model-matches/' + checkpoint.seriesId);
  const progress = `${detail.recordedGames}/${detail.expectedGames} ${detail.status}`;
  if (progress !== previous) { console.log(progress); previous = progress; }
  checkpoint.progress = { recordedGames: detail.recordedGames, expectedGames: detail.expectedGames, status: detail.status };
  await save();
  if (!['queued', 'running'].includes(detail.status)) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (detail.status !== 'completed') throw new Error('Batch did not complete: ' + detail.status);
const records = [];
const batchGames = detail.games.filter(g => g.batchId === checkpoint.batchId);
assert.equal(batchGames.length, 100);
const seats = new Map(), results = new Map([[a, { wins: 0, draws: 0, losses: 0 }], [b, { wins: 0, draws: 0, losses: 0 }]]);
const failures = ['model-error', 'model-timeout', 'invalid-response', 'illegal-action'];
for (const listed of batchGames) {
  const game = await call(`/api/model-matches/${checkpoint.seriesId}/games/${listed.index}`);
  assert.equal(game.status, 'completed');
  let final;
  for (const frame of replaySteps(game)) final = frame.state;
  assert.equal(game.moves.length, game.finalPly);
  if (game.termination === 'max-plies') {
    assert.equal(game.winner, 'draw'); assert.equal(game.finalPly, 256); assert.equal(final.winner, null);
  } else if (failures.includes(game.termination)) {
    assert.equal(final.winner, null); assert.equal(game.winner, 1 - final.turn);
  } else { assert.equal(final.winner, game.winner); assert.equal(final.termination, game.termination); }
  for (const move of game.moves) assert.ok(Number.isFinite(move.elapsedMs) && move.elapsedMs >= 0 && move.elapsedMs < 60000);
  // Series ordering is canonical and can differ from the submitted A/B order.
  const sideOfA = detail.models.a === a ? game.aSide : 1 - game.aSide;
  const seat = `${sideOfA}:${game.first}`;
  seats.set(seat, (seats.get(seat) || 0) + 1);
  const winner = game.winner === 'draw' ? null : game.winner === sideOfA ? a : b;
  for (const [id, tally] of results) tally[winner === null ? 'draws' : winner === id ? 'wins' : 'losses']++;
  records.push(game);
}
assert.equal(seats.size, 4);
assert.ok([...seats.values()].every(n => n === 25));
const summary = [...results].map(([modelId, tally]) => ({ modelId, ...tally, winRate: tally.wins / 100, scoreRate: (tally.wins + tally.draws / 2) / 100 }));
const uniqueLines = new Set(records.map(g => JSON.stringify([g.aSide, g.first, g.moves.map(m => m.action), g.winner, g.termination]))).size;
checkpoint.status = 'completed';
checkpoint.finishedAt = new Date().toISOString();
checkpoint.summary = summary;
checkpoint.uniqueLines = uniqueLines;
checkpoint.modelFailures = records.filter(g => failures.includes(g.termination)).length;
checkpoint.verifiedGames = records.length;
checkpoint.batches = detail.batches.filter(batch => batch.id === checkpoint.batchId);
await writeFile(path.join(directory, 'web-' + label + '-games.jsonl'), records.map(g => JSON.stringify(g)).join('\n') + '\n');
await save();
console.log(JSON.stringify({ url: checkpoint.url, summary, verifiedGames: records.length, uniqueLines, modelFailures: checkpoint.modelFailures }, null, 2));
