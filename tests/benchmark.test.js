import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { initialState, legalActions } from '../src/engine.js';
import { makeJob, loadRegistry, summarize, sha256 } from '../bench/common.mjs';
import { playGame } from '../bench/referee.mjs';
import { verifyGame } from '../bench/replay.mjs';
import { verifyRun } from '../bench/verify-run.mjs';

const options = { seed: 17, openingPlies: 2, moveMs: 2000, maxPlies: 32 };
const fixture = (name, config = {}) => ({ id: name, config, entryPath: fileURLToPath(new URL('./fixtures/model.mjs', import.meta.url)) });

test('schedule balances colors/first side and keeps paired opening histories', () => {
  const jobs = Array.from({ length: 4 }, (_, i) => makeJob(i, options));
  assert.deepEqual(jobs.map(j => [j.aSide, j.first]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(jobs[0].startState, jobs[1].startState);
  assert.deepEqual(jobs[2].startState, jobs[3].startState);
  assert.deepEqual(jobs, Array.from({ length: 4 }, (_, i) => makeJob(i, options)));
});

test('registered models load; seeded baseline and completed game replays', async () => {
  const registry = await loadRegistry();
  const { think } = await import('../models/random.mjs');
  const state = initialState();
  const input = { state, legalActions: legalActions(state), seed: 10 };
  assert.deepEqual(think(input), think(input));
  const models = ['greedy-v1', 'random-v1'].map(id => registry.find(m => m.id === id));
  const game = await playGame(makeJob(0, options), models, options);
  assert.equal(verifyGame(game), true);
  const broken = structuredClone(game); broken.finalKey = 'corrupted';
  assert.throws(() => verifyGame(broken));
  const summary = summarize([game], 1000);
  assert.equal(summary.wins + summary.draws + summary.losses, 1);
});

test('model infinite loop is hard-stopped and loses without stalling referee', async () => {
  const opts = { ...options, moveMs: 40, openingPlies: 0 };
  const game = await playGame(makeJob(0, opts), [fixture('loop', { mode: 'loop' }), fixture('ok')], opts);
  assert.equal(game.termination, 'model-timeout'); assert.equal(game.winner, 1);
  assert.equal(verifyGame(game), true);
});

for (const [mode, reason] of [['throw', 'model-error'], ['invalid', 'invalid-response'], ['illegal', 'illegal-action'], ['exit', 'model-error']]) {
  test(`model ${mode} produces explicit ${reason} loss`, async () => {
    const opts = { ...options, openingPlies: 0 };
    const game = await playGame(makeJob(0, opts), [fixture('bad', { mode }), fixture('ok')], opts);
    assert.equal(game.termination, reason); assert.equal(game.winner, 1);
    assert.equal(verifyGame(game), true);
  });
}

test('max plies is an evaluation draw and is replayable', async () => {
  const opts = { ...options, openingPlies: 0, maxPlies: 1 };
  const game = await playGame(makeJob(0, opts), [fixture('a'), fixture('b')], opts);
  assert.equal(game.termination, 'max-plies'); assert.equal(game.winner, 'draw');
  assert.equal(verifyGame(game), true);
});

test('complete run verification catches missing games, changed summary and mixed config', async () => {
  const opts = { ...options, openingPlies: 0, maxPlies: 1, games: 4, a: 'a', b: 'b' };
  const config = { runId: 'test-run', ruleset: 'twelve-janggi-strict-v2', engineHash: 'test-engine', options: opts };
  config.configHash = sha256(JSON.stringify(config));
  const games = [];
  for (let index = 0; index < 4; index++) games.push({ ...await playGame(makeJob(index, opts), [fixture('a'), fixture('b')], opts), runId: config.runId, configHash: config.configHash });
  const summary = { runId: config.runId, configHash: config.configHash, a: 'a', b: 'b', ...summarize(games, 1000) };
  summary.participants = ['a', 'b'].map(modelId => ({ modelId, wins: 0, draws: 4, losses: 0, winRate: 0, scoreRate: 0.5, modelFailures: 0, timing: summary.timing[modelId] }));
  assert.equal(verifyRun(config, summary, games, 'test-engine'), true);
  assert.throws(() => verifyRun(config, summary, games.slice(1), 'test-engine'), /incomplete/);
  assert.throws(() => verifyRun(config, { ...summary, wins: 1 }, games, 'test-engine'), /summary mismatch/);
  const mixed = structuredClone(games); mixed[0].configHash = 'other';
  assert.throws(() => verifyRun(config, summary, mixed, 'test-engine'), /mixed run configuration/);
});
