import test from 'node:test';
import assert from 'node:assert/strict';
import { solveWin } from '../models/dfpn-proof-v1.mjs';
import { FastPosition, actionCode, decodeAction } from '../models/pvs-aspiration-rules-v1.mjs';
import { applyAction, createPosition, initialState, legalActions, positionKey } from '../src/engine.js';

function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);
  for (const [square, side, kind] of pieces) board[square] = { side, kind };
  return createPosition({ board, turn, hands });
}
function mirror(s) {
  return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn });
}
// Independent three-valued exhaustive oracle using only official transitions.
// A frontier is unknown, never a draw or a defeated attacking proposition.
function oracle(s, attacker, depth) {
  if (s.winner !== null) return s.winner === attacker ? 'win' : 'loss';
  if (!depth) return 'unknown';
  const results = legalActions(s).map(a => oracle(applyAction(s, a, false), attacker, depth - 1));
  if (s.turn === attacker) return results.includes('win') ? 'win' : results.every(r => r === 'loss') ? 'loss' : 'unknown';
  return results.includes('loss') ? 'loss' : results.every(r => r === 'win') ? 'win' : 'unknown';
}
function snapshot(p) {
  return { key: p.key(), counts: new Map(p.counts), kings: [...p.kings], winner: p._winner };
}
function solve(s, attacker, options) {
  const before = structuredClone(s), p = new FastPosition(s), original = snapshot(p);
  const result = solveWin(p, attacker, options);
  assert.deepEqual(snapshot(p), original);
  assert.deepEqual(s, before);
  assert.ok(result.nodes <= (options?.maxNodes ?? 1000));
  return result;
}

test('DFPN proves immediate try, checkmate and quiet no-legal-actions wins for either color', () => {
  const positions = [
    fixture([[2, 0, 'king'], [11, 1, 'king']]),
    fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]),
    fixture([[0, 0, 'king'], [6, 1, 'king'], [4, 1, 'bishop']], 1),
  ];
  const quiet = applyAction(positions[2], { from: 4, to: 9 }, false);
  assert.equal(quiet.termination, 'no-legal-actions');
  for (const original of positions) for (const state of [original, mirror(original)]) {
    const result = solve(state, state.turn, { maxDepth: 1, maxNodes: 1000 });
    assert.equal(result.status, 'win');
    assert.ok(Number.isInteger(result.move));
    assert.equal(applyAction(state, decodeAction(result.move), false).winner, state.turn);
  }
});

test('DFPN proves a unique three-ply win and depth frontier remains unknown', () => {
  const original = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  for (const state of [original, mirror(original)]) {
    const winning = legalActions(state).filter(action => oracle(applyAction(state, action, false), state.turn, 2) === 'win');
    assert.equal(winning.length, 1);
    assert.equal(solve(state, state.turn, { maxDepth: 2, maxNodes: 10000 }).status, 'unknown');
    const result = solve(state, state.turn, { maxDepth: 3, maxNodes: 10000 });
    assert.equal(result.status, 'win');
    assert.deepEqual(decodeAction(result.move), winning[0]);
  }
});

test('DFPN results agree with an exhaustive official oracle at depths three and five', () => {
  const states = [initialState(), initialState(1), fixture([[0, 0, 'king'], [11, 1, 'king']]), fixture([[1, 0, 'king'], [11, 1, 'king']])];
  for (const depth of [3, 5]) for (const state of states) for (const attacker of [0, 1]) {
    const expected = oracle(state, attacker, depth);
    const result = solve(state, attacker, { maxDepth: depth, maxNodes: 100000 });
    assert.equal(result.status, expected, JSON.stringify({ depth, attacker, result, expected }));
    if (result.status === 'win' && attacker === state.turn) assert.equal(oracle(applyAction(state, decodeAction(result.move), false), attacker, depth - 1), 'win');
  }
});

test('DFPN proves only sound outcomes over varied reachable positions', () => {
  let state = initialState(), seed = 806321, provedWins = 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 64; i++) {
    if (state.winner !== null || state.ply > 128) state = initialState(i % 2);
    for (const attacker of [0, 1]) {
      const expected = oracle(state, attacker, 3);
      const result = solve(state, attacker, { maxDepth: 3, maxNodes: 100000 });
      // A blocked disproof can conservatively return unknown even if another
      // unexplored defense would disprove the proposition. Every reported
      // conclusive outcome must be sound; all finite-depth wins are provable.
      if (result.status !== 'unknown' || expected === 'win') assert.equal(result.status, expected);
      if (result.status === 'win') provedWins++;
    }
    const actions = legalActions(state);
    state = applyAction(state, actions[random() % actions.length], false);
  }
  assert.ok(provedWins > 0);
});

test('DFPN distinguishes a depth-blocked disproof from a genuine defender escape', () => {
  const state = fixture([[2, 0, 'king'], [11, 1, 'king']]);
  // Defender (blue) can win immediately, refuting red regardless of how other
  // blue continuations hit the depth frontier. Conversely blue has a proof.
  assert.equal(solve(state, 1, { maxDepth: 1, maxNodes: 1000 }).status, 'loss');
  assert.equal(solve(state, 0, { maxDepth: 1, maxNodes: 1000 }).status, 'win');
  assert.equal(solve(initialState(), 0, { maxDepth: 0, maxNodes: 1000 }).status, 'unknown');
});

test('DFPN handles terminal draws, exact repetition histories and games past ply 256', () => {
  let state = fixture([[0, 0, 'king'], [11, 1, 'king']]);
  const cycle = [{ from: 0, to: 4 }, { from: 11, to: 7 }, { from: 4, to: 0 }, { from: 7, to: 11 }];
  for (const action of [...cycle, ...cycle]) state = applyAction(state, action, false);
  assert.equal(state.winner, 'draw');
  for (const attacker of [0, 1]) assert.equal(solve(state, attacker, { maxNodes: 1 }).status, 'loss');
  const running = fixture([[0, 0, 'king'], [11, 1, 'king']]);
  const nextKey = positionKey(applyAction(running, cycle[0], false));
  const repeated = { ...running, positions: [nextKey, nextKey, ...running.positions] };
  for (const attacker of [0, 1]) assert.equal(solve(repeated, attacker, { maxDepth: 3, maxNodes: 10000 }).status, oracle(repeated, attacker, 3));
  const immediate = fixture([[2, 0, 'king'], [11, 1, 'king']]);
  assert.equal(solve({ ...immediate, ply: 400 }, 0, { maxDepth: 1, maxNodes: 1000 }).status, 'win');
});

test('DFPN respects zero/one node budgets and restores nested state when callback throws', () => {
  const state = initialState();
  for (const maxNodes of [0, 1]) {
    const result = solve(state, state.turn, { maxDepth: 32, maxNodes });
    assert.equal(result.status, 'unknown');
    assert.equal(result.nodes, maxNodes);
  }
  for (const maxNodes of [2, 7, 25]) {
    const result = solve(state, state.turn, { maxDepth: 32, maxNodes });
    assert.equal(result.status, 'unknown');
    assert.equal(result.nodes, maxNodes);
  }
  const p = new FastPosition(state), before = snapshot(p), stop = new Error('external deadline');
  let visits = 0;
  assert.throws(() => solveWin(p, state.turn, { maxDepth: 32, maxNodes: 1000, check() { if (++visits === 7) throw stop; } }), error => error === stop);
  assert.deepEqual(snapshot(p), before);
  assert.equal(p.winner(), null);
  assert.deepEqual(p.actions(), legalActions(state).map(actionCode));
});
