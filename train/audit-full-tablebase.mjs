import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyAction, legalActions, positionKey } from '../src/engine.js';
import { keyOf, readBatch } from './verify-full-tablebase.mjs';

const [exe, table, database, model = 'tablebase-minimax-reply-v1', opponent = 'azero-v2'] = process.argv.slice(2);
if (!database) throw new Error('Usage: node train/audit-full-tablebase.mjs EXE TABLE DATABASE [MODEL OPPONENT]');
const db = new DatabaseSync(database, { readOnly: true });
let rows;
try {
  rows = db.prepare(`SELECT va.legacy_registry_id a, m.a_side, g.initial_state, g.current_state, g.result
    FROM model_matches m JOIN model_versions va ON va.id=m.model_a JOIN model_versions vb ON vb.id=m.model_b
    JOIN games g ON g.id=m.game_id WHERE g.result IN ('0','1') AND
    ((va.legacy_registry_id=? AND vb.legacy_registry_id=?) OR (vb.legacy_registry_id=? AND va.legacy_registry_id=?))`)
    .all(model, opponent, model, opponent);
} finally { db.close(); }

const losing = rows.filter(row => Number(row.result) !== (row.a === model ? row.a_side : 1 - row.a_side));
const lines = new Map(), keys = new Set();
const code = key => {
  const [, turn, board, a, b] = key.split('|');
  return keyOf({ turn: Number(turn), board: board.split(',').map(token => token === '-' ? null :
    { side: Number(token[0]), kind: token.slice(1) }), hands: [a, b].map(hand => hand ? hand.split(',') : []) });
};
const actionOf = ({ from, to, drop, kind }) => drop ? { drop: kind, to } : { from, to };

function lookupInput(state, perspective) {
  if (state.winner !== null) return { exact: state.winner === 'draw' ? 0 : state.winner === perspective ? 1 : -1 };
  const key = keyOf(state);
  keys.add(key);
  const occurrences = new Map();
  for (const original of state.positions) occurrences.set(original, (occurrences.get(original) ?? 0) + 1);
  const prior = [...occurrences].filter(([, count]) => count >= 2).map(([original]) => code(original));
  for (const earlier of prior) keys.add(earlier);
  return { key, prior, sign: state.turn === perspective ? 1 : -1 };
}

for (const row of losing) {
  let state = JSON.parse(row.initial_state);
  const end = JSON.parse(row.current_state), side = row.a === model ? row.a_side : 1 - row.a_side;
  const actions = end.log.slice(state.log.length).map(actionOf);
  const signature = JSON.stringify([side, state.positions, actions]);
  if (lines.has(signature)) { lines.get(signature).count++; continue; }
  const line = { count: 1, starts: state.turn === side, initial: lookupInput(state, side), decisions: [] };
  lines.set(signature, line);
  for (const action of actions) {
    const next = applyAction(state, action, false);
    if (state.turn === side) {
      const played = JSON.stringify(action);
      const choices = legalActions(state).map(move => {
        const taken = JSON.stringify(move) === played;
        return { move, taken, lookup: lookupInput(taken ? next : applyAction(state, move, false), side) };
      });
      line.decisions.push({ ply: state.ply + 1, choices });
    }
    state = next;
  }
  assert.equal(state.winner, end.winner);
  assert.equal(positionKey(state), positionKey(end));
}

const positions = [...keys], answers = positions.length ? readBatch(exe, ['probe', table], positions) : [];
const probes = new Map(positions.map((key, i) => {
  const [status, distance] = answers[i].split('/');
  return [key, { value: status === 'win' ? 1 : status === 'loss' ? -1 : status === 'draw' ? 0 : null,
    distance: Number(distance ?? Infinity) }];
}));
function evaluate({ exact, key, prior, sign }) {
  if (exact !== undefined) return exact;
  const entry = probes.get(key);
  if (entry.value === null) return null;
  if (entry.value !== 0 && prior.some(earlier => probes.get(earlier).distance < entry.distance)) return null;
  return entry.value * sign;
}

const results = [...lines.values()].map(line => {
  let firstAvoidableLoss = null, firstMissedWin = null, unverifiedDecisions = 0;
  for (const decision of line.decisions) {
    const choices = decision.choices.map(choice => ({ ...choice, value: evaluate(choice.lookup) }));
    const played = choices.find(choice => choice.taken);
    const best = choices.reduce((a, b) => b.value !== null && (a.value === null || b.value > a.value) ? b : a);
    if (choices.some(choice => choice.value === null)) unverifiedDecisions++;
    const detail = { ply: decision.ply, played: played.move, alternative: best.move, alternativeResult: best.value };
    if (played.value === -1 && (best.value === 0 || best.value === 1) && !firstAvoidableLoss) firstAvoidableLoss = detail;
    if (played.value === 0 && best.value === 1 && !firstMissedWin) firstMissedWin = detail;
  }
  return { count: line.count, starts: line.starts, initialResult: evaluate(line.initial),
    firstAvoidableLoss, firstMissedWin, unverifiedDecisions };
});
console.log(JSON.stringify({ completedLosses: losing.length, uniqueLines: results.length,
  verifiedAvoidableLines: results.filter(line => line.firstAvoidableLoss).length, results }, null, 2));
