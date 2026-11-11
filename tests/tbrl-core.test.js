import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, initialState, legalActions } from '../src/engine.js';
import { FastPosition, actionCode } from '../models/pvs-aspiration-rules-v1.mjs';
import { openFullTablebase } from '../models/full-tablebase-v2.mjs';
import { openTable, classify, safeCandidates, trapFeatures, positionFromFeatures, rng } from '../models/tbrl-core.mjs';

test('tbrl table agrees with the reference full tablebase reader', () => {
  const reference = openFullTablebase(), table = openTable(64), random = rng(7);
  try {
    for (let g = 0; g < 20; g++) {
      let state = initialState(g % 2);
      while (state.winner === null && state.ply < 60) {
        const position = new FastPosition(state);
        assert.equal(table.probe(position), reference.probe(position));
        const actions = legalActions(state);
        state = applyAction(state, actions[Math.floor(random() * actions.length)], false);
      }
    }
  } finally { reference.close(); table.close(); }
});

test('feature rows rebuild the child position for probing (both sides)', () => {
  const table = openTable(256), random = rng(11);
  try {
    let checked = 0;
    for (let g = 0; g < 30; g++) {
      let state = initialState(g % 2);
      while (state.winner === null && state.ply < 50) {
        const actions = legalActions(state);
        for (const child of classify(state, actions, table)) {
          if (child.terminal) continue;
          const real = new FastPosition(state);
          real.make(child.move);
          real.counts = new Map(); // rows carry no repetition history
          const rebuilt = positionFromFeatures(child.features);
          const flip = state.turn === 1;
          // Same position up to the side-swapping rotation: identical table values.
          assert.equal(table.probe(rebuilt), table.probe(real));
          assert.deepEqual(Array.from(trapFeatures(rebuilt, table)), Array.from(trapFeatures(real, table)));
          if (!flip) assert.deepEqual(Array.from(rebuilt.board), Array.from(real.board));
          checked++;
        }
        state = applyAction(state, actions[Math.floor(random() * actions.length)], false);
      }
    }
    assert.ok(checked > 500);
  } finally { table.close(); }
});

test('safe candidates never contain a move that loses a drawn position', () => {
  const table = openTable(256), reference = openFullTablebase(), random = rng(3);
  try {
    for (let g = 0; g < 30; g++) {
      let state = initialState(g % 2);
      while (state.winner === null && state.ply < 80) {
        const actions = legalActions(state);
        const rootRaw = reference.probe(new FastPosition(state));
        const { tier, eligible } = safeCandidates(classify(state, actions, table));
        if (rootRaw === 1) assert.ok(tier >= 0, 'a drawn root keeps at least a draw');
        if (rootRaw >= 256) assert.equal(tier, 1, 'a won root keeps the win');
        for (const c of eligible) assert.ok(actions.some(a => actionCode(a) === c.move));
        state = applyAction(state, actions[Math.floor(random() * actions.length)], false);
      }
    }
  } finally { table.close(); reference.close(); }
});

test('tbrl-v2 returns legal moves that never worsen the proven result', async () => {
  const { analyze } = await import('../models/tbrl-v2.mjs');
  const reference = openFullTablebase(), random = rng(21);
  try {
    let checked = 0;
    for (let g = 0; g < 20; g++) {
      let state = initialState(g % 2);
      while (state.winner === null && state.ply < 80) {
        const actions = legalActions(state);
        const root = reference.probe(new FastPosition(state));
        const { action, info } = analyze({ state, legalActions: actions, seed: g * 1000 + state.ply, config: { hidden: [128, 64], trap: false } });
        assert.ok(actions.some(a => actionCode(a) === actionCode(action)), 'legal');
        assert.ok(info.searchMs < 1000);
        const next = applyAction(state, action, false);
        if (next.winner === null) {
          const after = reference.probe(new FastPosition(next)); // opponent's view
          if (root === 1) assert.ok(after === 1 || after <= -256, 'draw kept');
          if (root >= 256) assert.ok(after <= -256, 'win kept');
        } else if (root === 1 || root >= 256) assert.notEqual(next.winner, 1 - state.turn);
        checked++;
        state = applyAction(state, actions[Math.floor(random() * actions.length)], false);
      }
    }
    assert.ok(checked > 200);
  } finally { reference.close(); }
});
