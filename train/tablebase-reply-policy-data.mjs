import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyAction, legalActions } from '../src/engine.js';
import { actionCode, FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { replyFeatures } from '../models/tablebase-reply-policy-v1.mjs';
import { openTable } from '../models/tbrl-core.mjs';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node train/tablebase-reply-policy-data.mjs INPUT.sqlite OUTPUT.json');
const families = new Map([
  ['packed-gemm-puct-v2', 'packed'], ['azero-v2', 'alphazero'], ['stockjang-v1', 'stockjang'],
  ['minimax-v1', 'minimax'], ['team-mcts-v1', 'uct'], ['greedy-v1', 'greedy'],
]);
const db = new DatabaseSync(source, { readOnly: true });
const table = openTable();
try {
  const games = db.prepare(`SELECT g.id, g.initial_state, m.a_side, a.manifest AS a, b.manifest AS b
    FROM model_matches m JOIN games g ON g.id=m.game_id
    JOIN model_versions a ON a.id=m.model_a JOIN model_versions b ON b.id=m.model_b
    JOIN model_batch_games bg ON bg.match_id=m.id JOIN model_batches ba ON ba.id=bg.batch_id
    JOIN model_series s ON s.id=ba.series_id
    WHERE m.status='completed' AND s.deleted_at IS NULL`).all();
  const moves = db.prepare('SELECT action FROM moves WHERE game_id=? ORDER BY ply');
  const positions = new Map();
  for (const game of games) {
    const family = [game.a, game.b].map(json => {
      const manifest = JSON.parse(json);
      return families.get(manifest.registryId ?? manifest.id);
    });
    if (!family.some(Boolean)) continue;
    let state = JSON.parse(game.initial_state);
    for (const record of moves.iterate(game.id)) {
      const action = JSON.parse(record.action);
      const style = family[Number(state.turn !== game.a_side)];
      if (style) {
        const position = new FastPosition(state);
        if (table.probe(position) === 1) {
          const legal = legalActions(state);
          if (legal.length > 1) {
            const moves = legal.map(actionCode), played = moves.indexOf(actionCode(action));
            if (played < 0) throw new Error('Illegal recorded reply');
            const board = position.key();
            const rows = moves.map(move => {
              const undo = position.make(move);
              const replies = position.actions(), outcome = position.winner(replies);
              const raw = outcome === null ? table.probe(position) : 0;
              const repeat = position.counts.get(undo.key);
              const row = replyFeatures(position, move, outcome, raw, replies.length, !!undo.captured, repeat);
              position.unmake(undo);
              return { row, repeat, outcome };
            });
            // Deduplicate repeated starts and transpositions, while keeping
            // choices made with different repetition options separate.
            const key = JSON.stringify([board, rows.map(row => [row.repeat, row.outcome])]);
            let sample = positions.get(key);
            if (!sample) {
              sample = { board, rows: rows.map(({ row }) => Array.from(row)), choices: {} };
              positions.set(key, sample);
            }
            const counts = sample.choices[style] ??= Array(moves.length).fill(0);
            counts[played]++;
          }
        }
      }
      state = applyAction(state, action, false);
    }
  }
  const dataset = [...positions.values()];
  if (!dataset.length) throw new Error('No drawn positions with recorded replies');
  writeFileSync(output, JSON.stringify(dataset));
  const counts = Object.fromEntries([...families.values()].map(style => [style, dataset.filter(row => row.choices[style]).length]));
  console.log(JSON.stringify({ positions: dataset.length, boards: new Set(dataset.map(row => row.board)).size, byStyle: counts }));
} finally { table.close(); db.close(); }
