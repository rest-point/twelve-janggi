import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createExperimentStore } from '../scripts/experiment-store.mjs';
import { initialState, legalActions, applyAction, positionKey } from '../src/engine.js';
import { replayFrames } from '../src/record-replay.js';

const id = '2026-10-31T00-00-00-000Z-aabbccdd';
function fixture() {
  const state = initialState(0), action = legalActions(state)[0], next = applyAction(state, action, false);
  return { runId: id, index: 0, first: 0, aSide: 0, opening: [], startState: state, moves: [{ ply: next.ply, side: 0, action, elapsedMs: 1.5, positionKey: positionKey(next) }], finalPly: next.ply, finalKey: positionKey(next), winner: 'draw', termination: 'max-plies' };
}
async function withStore(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'twelve-records-'));
  try {
    const directory = path.join(temp, id); await mkdir(directory);
    await writeFile(path.join(directory, 'config.json'), JSON.stringify({ runId: id, configHash: 'hash', options: { a: 'a', b: 'b', games: 1 } }));
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ runId: id, configHash: 'hash', games: 1 }));
    await writeFile(path.join(directory, 'games.jsonl'), JSON.stringify(fixture()) + '\n');
    await run(createExperimentStore(temp), directory);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
}

test('stored runs expose every game and the original replay/timing', async () => {
  await withStore(async store => {
    assert.equal((await store.list()).length, 1);
    const detail = await store.detail(id);
    assert.equal(detail.games.length, 1); assert.equal(detail.recordedGames, 1);
    const game = await store.game(id, 0);
    assert.equal(game.moves[0].elapsedMs, 1.5);
    const frames = replayFrames(game);
    assert.equal(frames.length, 2);
    assert.equal(positionKey(frames.at(-1).state), game.finalKey);
    await assert.rejects(store.game(id, 1), /찾을 수/);
  });
});
test('partial runs are labelled incomplete; corrupt/missing/duplicate records are rejected', async () => {
  await withStore(async (store, directory) => {
    await rm(path.join(directory, 'summary.json'));
    assert.equal((await store.detail(id)).status, 'incomplete');
    await writeFile(path.join(directory, 'games.jsonl'), '{broken');
    await assert.rejects(store.detail(id), /기록 중/);
    await writeFile(path.join(directory, 'games.jsonl'), [fixture(), fixture()].map(JSON.stringify).join('\n'));
    await assert.rejects(store.detail(id), /형식/);
  });
});
test('record store rejects traversal, mixed experiment IDs and wrong completed counts', async () => {
  await withStore(async (store, directory) => {
    await assert.rejects(store.detail('../package.json'), /실험 ID/);
    await writeFile(path.join(directory, 'games.jsonl'), JSON.stringify({ ...fixture(), runId: 'other' }));
    await assert.rejects(store.detail(id), /형식/);
    await writeFile(path.join(directory, 'games.jsonl'), '');
    await assert.rejects(store.detail(id), /건수/);
  });
});
test('browser replay includes opening history and rejects altered actions', () => {
  const original = fixture(), openingState = applyAction(original.startState, original.moves[0].action, false);
  const game = { ...original, opening: [original.moves[0].action], startState: openingState, moves: [] };
  const frames = replayFrames(game);
  assert.equal(frames[1].opening, true); assert.equal(frames[1].elapsedMs, null);
  const broken = fixture(); broken.moves[0].positionKey = 'corrupted';
  assert.throws(() => replayFrames(broken), /기보 검증/);
});
test('web server provides archive routes and blocks source secrets/artifact paths', async () => {
  const server = spawn(process.execPath, ['scripts/server.mjs', '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
      server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    assert.equal((await fetch(url + '/experiments')).status, 200);
    const response = await fetch(url + '/api/experiments');
    assert.equal(response.status, 200); assert.ok(Array.isArray((await response.json()).experiments));
    for (const route of ['/.env', '/package.json', '/artifacts/anything', '/scripts/server.mjs', '/api/experiments/invalid']) assert.ok((await fetch(url + route)).status >= 400, route);
    assert.equal((await fetch(url + '/api/experiments', { method: 'POST' })).status, 405);
  } finally {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited;
  }
});
