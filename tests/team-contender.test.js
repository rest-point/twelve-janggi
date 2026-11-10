import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createPosition, initialState, isLegalAction, legalActions } from '../src/engine.js';
import { denseIndex, openFullTablebase } from '../models/full-tablebase-v2.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { actionCode } from '../models/pvs-aspiration-rules-v1.mjs';
import { analyze, classifyTablebase } from '../models/team-contender-search-v1.mjs';

function fixture({ turn = 0, pawn = null, hands = [[], []] } = {}) {
  const board = Array(12).fill(null);
  board[0] = { side: 0, kind: 'king' };
  board[11] = { side: 1, kind: 'king' };
  if (pawn !== null) board[pawn] = { side: turn, kind: 'pawn' };
  return createPosition({ board, hands, turn });
}

function mockServices({ probe = () => 0, probeKey = () => 0, proveWin = () => ({ status: 'unknown' }), now = () => performance.now() } = {}) {
  return {
    tablebase: { probe, probeKey },
    scorePolicyValue: (_position, moves) => ({ value: 0, priors: moves.map((_, index) => -index) }),
    proveWin,
    now,
  };
}

test('both standard starting positions are supported tablebase draws', () => {
  const tablebase = openFullTablebase();
  try {
    for (const first of [0, 1]) {
      const position = new FastPosition(initialState(first));
      assert.ok(denseIndex(position.board, position.hands, position.turn) >= 0);
      assert.deepEqual(classifyTablebase(position, tablebase), {
        outcome: 0, distance: null, score: 0, certain: true, terminal: false,
      });
    }
  } finally { tablebase.close(); }
});

test('captures, prisoner drops, and promotion states stay in the full-material index', () => {
  let state = initialState(0);
  state = applyAction(state, { from: 5, to: 6 }, false);
  assert.ok(state.hands[0].includes('pawn'));
  state = applyAction(state, legalActions(state)[0], false);
  const drop = legalActions(state).find(action => action.drop === 'pawn');
  assert.ok(drop, 'captured pawn should be deployable');
  state = applyAction(state, drop, false);
  let position = new FastPosition(state);
  assert.ok(denseIndex(position.board, position.hands, position.turn) >= 0);

  const promotion = fixture({ pawn: 2, hands: [[], ['rook', 'rook', 'bishop', 'bishop', 'pawn']] });
  const promotionPosition = new FastPosition(promotion);
  assert.ok(denseIndex(promotionPosition.board, promotionPosition.hands, promotionPosition.turn) >= 0);
  const promoted = applyAction(promotion, { from: 2, to: 3 }, false);
  assert.equal(promoted.board[3].kind, 'hen');
  position = new FastPosition(promoted);
  assert.ok(denseIndex(position.board, position.hands, position.turn) >= 0);
});

test('tablebase win/loss codes preserve distance and prefer faster wins', () => {
  const state = initialState(0);
  const slow = classifyTablebase(new FastPosition(state), { probe: () => 300, probeKey: () => 1 });
  const fast = classifyTablebase(new FastPosition(state), { probe: () => 280, probeKey: () => 1 });
  const loss = classifyTablebase(new FastPosition(initialState(1)), { probe: () => -275, probeKey: () => 1 });
  assert.equal(fast.outcome, 1);
  assert.equal(slow.distance, 44);
  assert.equal(fast.distance, 24);
  assert.equal(loss.outcome, -1);
  assert.equal(loss.distance, 19);
  assert.ok(fast.score > slow.score, 'shorter tablebase wins must score higher');
});

test('official third-occurrence draw takes precedence over a history-free tablebase win', () => {
  const state = initialState(0), key = state.positions.at(-1);
  const repeated = { ...state, positions: [key, key, key] };
  let probes = 0;
  const result = classifyTablebase(new FastPosition(repeated), { probe: () => { probes++; return 300; }, probeKey: () => 300 });
  assert.equal(result.outcome, 0);
  assert.equal(result.terminal, true);
  assert.equal(probes, 0);
});

test('a twice-seen prior position makes a history-free tablebase win uncertain', () => {
  const state = initialState(0), key = state.positions.at(-1);
  const repeated = { ...state, positions: [key, key] };
  const result = classifyTablebase(new FastPosition(repeated), { probe: () => 300, probeKey: () => 1 });
  assert.equal(result.outcome, 1);
  assert.equal(result.distance, 44);
  assert.equal(result.certain, false);
});

test('unsupported material uses neural-guided fallback and only a proved win is conclusive', () => {
  const state = fixture(), actions = legalActions(state), request = { state, legalActions: actions, budgetMs: 400, config: { maxTimeMs: 100, maxDepth: 3, maxNodes: 300 } };
  const before = structuredClone(request), firstMove = actionCode(actions[0]);
  const services = mockServices({ proveWin: () => ({ status: 'loss', move: firstMove }) });
  const result = analyze(request, services);
  assert.ok(isLegalAction(state, result.action));
  assert.ok(result.info.unsupportedProbes > 0);
  assert.ok(result.info.policyEvals > 0);
  assert.equal(result.info.provenWin, false, 'a DFPN disproof is not an opponent-win proof');
  assert.deepEqual(request, before);
});

test('the search chooses a quicker exact win even when policy ordering prefers a slower win', () => {
  const state = initialState(0), actions = legalActions(state), position = new FastPosition(state);
  const outcomes = new Map();
  for (const [index, action] of actions.slice(0, 2).entries()) {
    const undo = position.make(actionCode(action));
    outcomes.set(position.key(), index === 0 ? -264 : -257);
    position.unmake(undo);
  }
  const result = analyze({ state, legalActions: actions, budgetMs: 200, config: { maxTimeMs: 100, maxDepth: 1 } },
    mockServices({ probe: candidate => candidate.turn === 0 ? 1 : outcomes.get(candidate.key()) ?? 1 }));
  assert.deepEqual(result.action, actions[1]);
  assert.equal(result.info.completedDepth, 1);
});

test('DFPN win proof may return its legal move, while other statuses cannot claim a win', () => {
  const state = fixture(), actions = legalActions(state), first = actionCode(actions[0]);
  const request = { state, legalActions: actions, budgetMs: 300, config: { maxTimeMs: 100, maxDepth: 2 } };
  const services = mockServices({ proveWin: () => ({ status: 'win', move: first, nodes: 23 }) });
  const result = analyze(request, services);
  assert.deepEqual(result.action, actions[0]);
  assert.equal(result.info.provenWin, true);
  assert.equal(result.info.proofNodes, 23);
});

test('tiny budgets return the first legal action without reporting a completed iteration', () => {
  const state = fixture(), actions = legalActions(state), request = { state, legalActions: actions, budgetMs: 1, config: { maxTimeMs: 1 } };
  const result = analyze(request, mockServices());
  assert.deepEqual(result.action, actions[0]);
  assert.equal(result.info.completedDepth, 0);
  assert.equal(result.info.proofCompleted, false);
});

test('side-one drops, promotions, and king safety use referee-legal actions without mutation', () => {
  const sideOne = fixture({ turn: 1, hands: [[], ['rook']] });
  const drops = legalActions(sideOne).filter(action => action.drop === 'rook');
  assert.ok(drops.length > 0);
  const request = { state: sideOne, legalActions: legalActions(sideOne), budgetMs: 250, config: { maxTimeMs: 100, maxDepth: 2 } };
  const before = structuredClone(request), result = analyze(request, mockServices());
  assert.ok(isLegalAction(sideOne, result.action));
  assert.deepEqual(request, before);

  const promotion = fixture({ turn: 1, pawn: 9, hands: [[], ['rook']] });
  const promoting = { from: 9, to: 8 };
  assert.equal(isLegalAction(promotion, promoting), true);
  const after = applyAction(promotion, promoting, false);
  assert.equal(after.board[8].kind, 'hen');
  assert.ok(isLegalAction(promotion, promoting));
});
