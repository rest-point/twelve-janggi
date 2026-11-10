import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, initialState, isInCheck, isLegalAction, legalActions } from '../src/engine.js';
import { FastPosition, actionCode } from '../models/pvs-aspiration-rules-v1.mjs';
import { analyze } from '../models/team-contender-search-v2.mjs';

test('v2 prefers a certain draw over a policy-favored win that history can only soften to draw', () => {
  const base = initialState(0), key = base.positions.at(-1), prior = key.replace('|0|', '|1|');
  const state = { ...base, positions: [key, prior, prior] }, actions = legalActions(state), position = new FastPosition(state);
  const outcomes = new Map();
  for (const [index, action] of actions.slice(0, 2).entries()) {
    const undo = position.make(actionCode(action));
    outcomes.set(position.key(), index === 0 ? 257 : 1);
    position.unmake(undo);
  }
  const checkingReply = applyAction(base, { from: 5, to: 6 }, false);
  assert.equal(isInCheck(checkingReply, checkingReply.turn), true);
  const evasionKeys = new Set(legalActions(checkingReply).map(action => {
    return new FastPosition(applyAction(checkingReply, action, false)).key();
  }));
  const request = { state, legalActions: actions, budgetMs: 200,
    config: { maxTimeMs: 100, maxDepth: 1, quiescenceDepth: 0 } };
  const before = structuredClone(request);
  const result = analyze(request, {
    tablebase: {
      probe(candidate) {
        const key = candidate.key();
        if (key === new FastPosition(base).key()) return 1;
        if (outcomes.has(key)) return outcomes.get(key);
        return evasionKeys.has(key) ? -257 : 257;
      },
      probeKey() { return 1; },
    },
    scorePolicyValue(_position, moves) { return { value: 0, priors: moves.map((_, index) => -index) }; },
    proveWin() { return { status: 'unknown' }; },
    now: () => performance.now(),
  });
  assert.deepEqual(result.action, actions[1]);
  assert.equal(isLegalAction(state, result.action), true);
  assert.deepEqual(request, before);
});
