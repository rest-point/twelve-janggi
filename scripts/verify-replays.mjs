import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { verifyGame } from '../bench/replay.mjs';
import { verifyRun } from '../bench/verify-run.mjs';
import { ROOT, sha256 } from '../bench/common.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || !['--input', '--run'].includes(args[0])) throw new Error('Usage: node scripts/verify-replays.mjs --run <run-directory> OR --input <games.jsonl>');
const completeRun = args[0] === '--run';
const input = completeRun ? path.join(args[1], 'games.jsonl') : args[1];
let count = 0;
const ids = new Set();
const games = [];
for await (const line of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const game = JSON.parse(line);
  const id = `${game.runId}:${game.index}`;
  if (ids.has(id)) throw new Error(`Duplicate game: ${id}`);
  ids.add(id);
  try { verifyGame(game); } catch (error) { throw new Error(`Replay mismatch in game ${game.index}: ${error.message}`); }
  if (completeRun) games.push(game);
  count++;
}
if (!count) throw new Error('No games to verify');
if (completeRun) {
  const config = JSON.parse(await readFile(path.join(args[1], 'config.json'), 'utf8'));
  const summary = JSON.parse(await readFile(path.join(args[1], 'summary.json'), 'utf8'));
  verifyRun(config, summary, games, sha256(await readFile(path.join(ROOT, 'src/engine.js'))));
  console.log(`Verified complete run: ${count} games; schedule, config hash, replays, deadlines and summary match.`);
} else {
  console.log(`Verified ${count} game replays. Use --run <directory> to also verify experiment completeness and summary.`);
}
