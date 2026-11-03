import assert from 'node:assert/strict';
import { positionKey } from '../src/engine.js';
import { replaySteps } from '../src/record-replay.js';

const modelFailures = ['model-error', 'model-timeout', 'invalid-response', 'illegal-action'];
export function verifyGame(game) {
  assert.ok(Number.isInteger(game.index) && game.index >= 0);
  assert.ok([0, 1].includes(game.first) && [0, 1].includes(game.aSide));
  let state, startState, frameIndex = 0;
  for (const frame of replaySteps(game)) {
    state = frame.state;
    if (frameIndex++ === game.opening.length) startState = state;
  }
  assert.equal(positionKey(startState), game.openingKey);
  assert.equal(startState.winner, null);
  for (const move of game.moves) {
    assert.ok(Number.isFinite(move.elapsedMs) && move.elapsedMs >= 0);
  }
  const accepted = game.attempts.filter(a => a.accepted);
  assert.equal(accepted.length, game.moves.length);
  for (let i = 0; i < accepted.length; i++) {
    assert.equal(accepted[i].side, game.moves[i].side);
    assert.equal(accepted[i].ply, game.moves[i].ply);
    assert.equal(accepted[i].elapsedMs, game.moves[i].elapsedMs);
  }
  if (game.termination === 'max-plies') {
    assert.equal(state.winner, null); assert.equal(game.winner, 'draw');
  } else if (modelFailures.includes(game.termination)) {
    assert.equal(state.winner, null);
    const failedStartup = game.startups.find(s => s.error);
    if (failedStartup) {
      assert.equal(game.termination, 'model-error');
      assert.equal(game.winner, 1 - failedStartup.side);
      assert.equal(game.moves.length, 0);
    } else {
      const failed = game.attempts.at(-1);
      assert.ok(failed && !failed.accepted);
      assert.equal(failed.side, state.turn);
      assert.equal(failed.error, game.termination);
      assert.equal(game.winner, 1 - state.turn);
    }
  } else {
    assert.notEqual(state.winner, null);
    assert.equal(game.winner, state.winner);
    assert.equal(game.termination, state.termination);
  }
  return true;
}
