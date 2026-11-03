import assert from 'node:assert/strict';
import { RULESET } from '../src/engine.js';
import { makeJob, sha256, summarize } from './common.mjs';

export function verifyRun(config, summary, games, engineHash) {
  const { configHash, ...content } = config;
  assert.equal(configHash, sha256(JSON.stringify(content)), 'config hash mismatch');
  assert.equal(config.ruleset, RULESET, 'ruleset mismatch');
  assert.equal(config.engineHash, engineHash, 'Use the archived engine version matching this run');
  assert.equal(summary.runId, config.runId);
  assert.equal(summary.configHash, configHash);
  assert.ok(Number.isSafeInteger(config.options.games) && config.options.games >= 4 && config.options.games % 4 === 0);
  assert.equal(games.length, config.options.games, 'incomplete run: missing games');
  const indices = new Set();
  for (const game of games) {
    assert.equal(game.runId, config.runId, 'mixed run IDs');
    assert.equal(game.configHash, configHash, 'mixed run configuration');
    assert.ok(Number.isInteger(game.index) && game.index >= 0 && game.index < config.options.games);
    assert.ok(!indices.has(game.index), 'duplicate game index'); indices.add(game.index);
    const expected = makeJob(game.index, config.options);
    for (const key of ['first', 'aSide', 'blockId', 'pairId', 'opening', 'startState']) assert.deepEqual(game[key], expected[key], `schedule mismatch: ${key}`);
    assert.ok(game.moves.length <= config.options.maxPlies);
    for (const move of game.moves) assert.ok(move.elapsedMs < config.options.moveMs, 'accepted a move after deadline');
    for (const attempt of game.attempts) assert.ok(Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs >= 0);
    if (game.termination === 'max-plies') assert.equal(game.moves.length, config.options.maxPlies);
  }
  assert.ok(Number.isFinite(summary.wallMs) && summary.wallMs > 0);
  const expected = summarize(games, summary.wallMs);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(summary[key], value, `summary mismatch: ${key}`);
  assert.equal(summary.a, config.options.a); assert.equal(summary.b, config.options.b);
  assert.deepEqual(summary.participants, [
    { modelId: summary.a, wins: expected.wins, draws: expected.draws, losses: expected.losses, winRate: expected.winRate, scoreRate: expected.scoreRate, modelFailures: expected.modelFailureCounts.a, timing: expected.timing.a },
    { modelId: summary.b, wins: expected.losses, draws: expected.draws, losses: expected.wins, winRate: expected.losses / expected.games, scoreRate: 1 - expected.scoreRate, modelFailures: expected.modelFailureCounts.b, timing: expected.timing.b },
  ]);
  return true;
}
