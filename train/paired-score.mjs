import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rng, percentile } from '../bench/common.mjs';

const [run, ...excludedRuns] = process.argv.slice(2);
if (!run) throw new Error('Usage: node train/paired-score.mjs RUN [TRAIN_OR_SCREEN_RUN ...]');
const readGames = directory => readFileSync(path.join(directory, 'games.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map(line => JSON.parse(line));
const excluded = new Set(excludedRuns.flatMap(directory => readGames(directory).map(game => game.openingKey ?? game.opening)));
const games = readGames(run);
const heldOut = games.filter(game => !excluded.has(game.openingKey));
const clusters = new Map();
const scores = { wins: 0, draws: 0, losses: 0 };
for (const game of heldOut) {
  const result = game.winner === 'draw' ? 'draws' : game.winner === game.aSide ? 'wins' : 'losses';
  scores[result]++;
  const cluster = clusters.get(game.openingKey) ?? { points: 0, count: 0 };
  cluster.points += result === 'wins' ? 1 : result === 'draws' ? 0.5 : 0;
  cluster.count++;
  clusters.set(game.openingKey, cluster);
}
const blocks = [...clusters.values()];
if (blocks.length < 2 || blocks.some(block => block.count % 2)) throw new Error('Need at least two complete opening pairs');
const random = rng(271107);
const bootstrap = Array.from({ length: 10000 }, () => {
  let points = 0, count = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[Math.floor(random() * blocks.length)];
    points += block.points;
    count += block.count;
  }
  return points / count;
});
const score = (scores.wins + scores.draws / 2) / heldOut.length;
const lower = percentile(bootstrap, 0.025), upper = percentile(bootstrap, 0.975);
const failures = games.filter(game => ['model-error', 'model-timeout', 'invalid-response', 'illegal-action'].includes(game.termination)).length;
console.log(JSON.stringify({
  games: heldOut.length, excluded: games.length - heldOut.length, openings: blocks.length,
  ...scores, scoreRate: score, confidence95: [lower, upper], failures,
  passed: heldOut.length >= 400 && score >= 0.55 && lower > 0.5 && failures === 0,
}, null, 2));
