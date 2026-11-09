import test from 'node:test';
import assert from 'node:assert/strict';
import { think, backupPath } from '../models/pv-puct-dfpn-v1.mjs';
import { applyAction, createPosition, initialState, isLegalAction, legalActions, positionKey } from '../src/engine.js';

const config = { simulations: 128, maxTimeMs: 55000, rootProofNodes: 1000, leafProofNodes: 40, proofDepth: 5 };
const request = (state, overrides = {}) => ({ state, legalActions: legalActions(state), config, budgetMs: 60000, seed: 73, ...overrides });
function fixture(pieces, turn = 0, hands = [[], []]) {
  const board = Array(12).fill(null);
  for (const [sq, side, kind] of pieces) board[sq] = { side, kind };
  return createPosition({ board, hands, turn });
}
function mirror(s) {
  return createPosition({ board: [...s.board].reverse().map(p => p ? { side: 1 - p.side, kind: p.kind } : null), hands: [s.hands[1], s.hands[0]], turn: 1 - s.turn });
}
function forceWin(s, side, depth) {
  if (s.winner !== null) return s.winner === side;
  if (!depth) return false;
  const results = legalActions(s).map(a => forceWin(applyAction(s, a, false), side, depth - 1));
  return s.turn === side ? results.some(Boolean) : results.every(Boolean);
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

test('policy/value PUCT selects immediate try, mate and quiet no-action wins for either side', () => {
  const states = [fixture([[2, 0, 'king'], [11, 1, 'king']]), fixture([[0, 0, 'king'], [5, 0, 'bishop'], [6, 0, 'rook'], [10, 0, 'bishop'], [3, 1, 'king']]), fixture([[0, 0, 'king'], [6, 1, 'king'], [4, 1, 'bishop']], 1)];
  for (const original of states) for (const s of [original, mirror(original)]) {
    const result = think(request(s));
    assert.equal(applyAction(s, result.action, false).winner, s.turn);
  }
});

test('DFPN overrides neural priors with the unique independently proved three-ply win', () => {
  const original = fixture([[0, 0, 'bishop'], [3, 0, 'hen'], [4, 0, 'king'], [6, 1, 'bishop'], [7, 1, 'pawn'], [8, 0, 'rook'], [11, 1, 'king']], 0, [['rook'], []]);
  for (const s of [original, mirror(original)]) {
    const wins = legalActions(s).filter(a => forceWin(applyAction(s, a, false), s.turn, 2));
    assert.equal(wins.length, 1);
    const result = think(request(s, { config: { ...config, simulations: 1, rootProofNodes: 10000, proofDepth: 3 } }));
    assert.deepEqual(result.action, wins[0]);
  }
});

test('PUCT handles both colors, hands, exact histories and ply >256 without modifying inputs', () => {
  const bare = fixture([[0, 0, 'king'], [11, 1, 'king']], 0, [['rook', 'bishop', 'pawn'], []]);
  const current = initialState();
  for (const s of [current, initialState(1), bare, mirror(bare), { ...current, ply: 400 }]) {
    const input = freeze(request(s)), before = structuredClone(input), result = think(input);
    assert.equal(isLegalAction(s, result.action), true);
    assert.deepEqual(input, before);
    assert.ok(Object.values(result.info).every(v => Number.isFinite(v) && v >= 0));
  }
  const options = { ...config, rootProofNodes: 0, leafProofNodes: 0 };
  const ordinary = think(request(current, { config: options }));
  assert.deepEqual(think(request({ ...current, ply: 400 }, { config: options })).action, ordinary.action);
  assert.equal(think(request(current, { config: { ...options, maxDepth: 1 } })).info.nodes > 0, true);
});

test('zero and short budgets return legal fallbacks; fixed simulations are deterministic across requests', () => {
  const s = initialState();
  for (const budgetMs of [0, 1, 5]) {
    const r = think(request(s, { budgetMs }));
    assert.equal(isLegalAction(s, r.action), true);
    assert.equal(r.info.nodes, 0);
  }
  const options = { ...config, simulations: 96, rootProofNodes: 0, leafProofNodes: 0, cacheEntries: 0 };
  const first = think(request(s, { config: options }));
  think(request(initialState(1)));
  const second = think(request(s, { config: options }));
  assert.deepEqual(first.action, second.action);
  assert.equal(first.info.nodes, second.info.nodes);
  const cached = think(request(s, { config: { ...options, cacheEntries: 2048 } }));
  assert.deepEqual(cached.action, first.action);
  assert.equal(cached.info.nodes, first.info.nodes);
  assert.throws(() => think(request(s, { legalActions: [] })), /No legal actions/);
});

test('DFPN visits are retained in public counters when a deadline interrupts proof search', t => {
  let ticks = 0;
  const clock = t.mock.method(performance, 'now', () => ++ticks);
  try {
    const s = initialState();
    const result = think(request(s, { config: { ...config, maxTimeMs: 100, rootProofNodes: 50000, proofDepth: 32 } }));
    assert.equal(isLegalAction(s, result.action), true);
    assert.equal(result.info.nodes, 99);
  } finally { clock.mock.restore(); }
});

test('PUCT recognizes an exact threefold successor and retains no history across requests', () => {
  const state = fixture([[2, 0, 'bishop'], [3, 1, 'rook'], [4, 0, 'king'], [6, 1, 'king'], [8, 0, 'rook'], [9, 1, 'pawn'], [11, 1, 'bishop']], 0, [[], ['pawn']]);
  const drawAction = { from: 2, to: 7 }, key = positionKey(applyAction(state, drawAction, false));
  const repeated = { ...state, positions: [key, key, ...state.positions] };
  // Restrict this probe to the known legal drawing edge, so it tests exact
  // terminal handling rather than assuming the neural model plays optimally.
  const r = think(request(repeated, { legalActions: [drawAction], config: { ...config, rootProofNodes: 0, simulations: 1200 } }));
  assert.deepEqual(r.action, drawAction);
  assert.equal(applyAction(repeated, r.action, false).winner, 'draw');
  const before = think(request(state));
  think(request(repeated));
  assert.deepEqual(think(request(state)).action, before.action);
});

test('newly proved draws and wins replace the final leaf sample when backing up to ancestors', () => {
  function node(children) {
    return { proven: null, actions: children.map((_, i) => i), children,
      N: new Uint32Array(children.length), W: new Float64Array(children.length),
      prior: new Float64Array(children.length).fill(1 / children.length), visitedPrior: 0, n: 0, sum: 0 };
  }
  const mixed = node([{ proven: 0 }, { proven: 1 }]);
  const root = node([mixed]);
  backupPath([[root, 0], [mixed, 1]], 1);
  assert.equal(mixed.proven, 0);assert.equal(root.proven, 0);
  assert.equal(root.W[0], 0.5);assert.equal(root.sum, 0.5);
  const forced = node([{ proven: -1 }, { proven: 1 }]), ancestor = node([forced]);
  backupPath([[ancestor, 0], [forced, 1]], 1);
  assert.equal(forced.proven, 1);assert.equal(ancestor.proven, -1);
  assert.equal(ancestor.W[0], 0);
});
