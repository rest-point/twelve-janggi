import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadRegistry, sha256 } from '../bench/common.mjs';
import { evaluate } from './evaluate.mjs';
import { writeJsonAtomic } from './lib/atomic-json.mjs';

// Bounded, resumable research runs. Official web batches are recorded separately.
const raw = process.argv.slice(2), args = {};
if (raw.length % 2) throw new Error('Expected --option value pairs');
for (let i = 0; i < raw.length; i += 2) {
  const name = raw[i].replace(/^--/, '');
  if (!['stage', 'games', 'a', 'b', 'seed', 'opening-plies', 'candidate-prefix'].includes(name) || Object.hasOwn(args, name)) throw new Error('Invalid option: ' + raw[i]);
  args[name] = raw[i + 1];
}
const stage = args.stage || 'screening';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid stage');
const models = await loadRegistry();
const original = models.filter(m => !m.id.startsWith('lab-'));
const directory = path.join(ROOT, 'artifacts', 'winrate-campaign', '2026-11-08');
await mkdir(directory, { recursive: true });
const filename = path.join(directory, stage + '.json');
const games = Number(args.games || 4);
if (!Number.isSafeInteger(games) || games < 4 || games > 1000 || games % 4) throw new Error('Games must be a multiple of four, at most 1000');
const openingPlies = Number(args['opening-plies'] || 0);
if (!Number.isSafeInteger(openingPlies) || openingPlies < 0 || openingPlies > 32 || (stage === 'screening' && openingPlies !== 0)) throw new Error('Invalid opening plies');
const pairs = stage === 'screening'
  ? original.flatMap((m, i) => original.slice(i + 1).map(n => [m.id, n.id]))
  : stage === 'candidates'
  ? models.filter(m => ['lab-stockjang-v1', 'lab-azero-v1', 'lab-azero-v2'].includes(m.id)).map(m => [m.id, args.b])
  : stage === 'neural-search'
  ? models.filter(m => ['lab-neural-v1', 'lab-neural-v2'].includes(m.id)).map(m => [m.id, args.b])
  : args['candidate-prefix']
  ? models.filter(m => m.id.startsWith(args['candidate-prefix'])).map(m => [m.id, args.b])
  : [[args.a, args.b]];
if (!pairs.length) throw new Error('No matching candidates');
for (const [a, b] of pairs) if (!models.some(m => m.id === a) || !models.some(m => m.id === b) || a === b) throw new Error('Invalid pair');
const snapshot = pairs.flat().filter((id, i, all) => all.indexOf(id) === i).map(id => {
  const m = models.find(model => model.id === id);
  return { id, artifactHash: m.artifactHash, config: m.config };
});
const seed = Number(args.seed || 20261108);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff - pairs.length) throw new Error('Invalid seed');
// The original AlphaZero models adjudicate at absolute ply 256. Keep the same
// absolute limit in diverse-opening research instead of causing model errors.
const settings = { stage, games, pairs, snapshot, moveMs: 60000, openingPlies, maxPlies: 256 - openingPlies, concurrency: 2, seed };
const fingerprint = sha256(JSON.stringify(settings));
let state;
try { state = JSON.parse(await readFile(filename, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
if (state && state.fingerprint !== fingerprint) throw new Error('Stage inputs changed; use a new stage ID');
state ||= { fingerprint, settings, startedAt: new Date().toISOString(), results: [], status: 'running' };
state.status = 'running';
delete state.error;

function ranking() {
  const rows = new Map(snapshot.map(m => [m.id, { id: m.id, games: 0, wins: 0, draws: 0, losses: 0, failures: 0 }]));
  for (const run of state.results) for (const participant of run.summary.participants) {
    const row = rows.get(participant.modelId);
    row.games += participant.wins + participant.draws + participant.losses;
    for (const key of ['wins', 'draws', 'losses']) row[key] += participant[key];
    row.failures += participant.modelFailures;
  }
  return [...rows.values()].map(r => ({ ...r, winRate: r.games ? r.wins / r.games : null,
    scoreRate: r.games ? (r.wins + r.draws / 2) / r.games : null }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || (b.scoreRate ?? -1) - (a.scoreRate ?? -1) || a.id.localeCompare(b.id));
}
async function save() {
  state.ranking = ranking();
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(filename, state);
  const percent = n => n === null ? '—' : (100 * n).toFixed(1) + '%';
  const lines = ['# ' + stage + ' research results', '',
    `Balanced colour/turn scenarios; opening plies ${settings.openingPlies}. Repeated deterministic games are not independent evidence.`, '',
    `Completed pairs: ${state.results.length}/${pairs.length}; status: ${state.status}`, '',
    '| Model | W | D | L | Win rate | Score rate | Model failures |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...state.ranking.map(r => `| ${r.id} | ${r.wins} | ${r.draws} | ${r.losses} | ${percent(r.winRate)} | ${percent(r.scoreRate)} | ${r.failures} |`), '',
    '| A | B | A W/D/L | Unique lines | Run ID |', '| --- | --- | --- | ---: | --- |',
    ...state.results.map(r => `| ${r.a} | ${r.b} | ${r.summary.wins}/${r.summary.draws}/${r.summary.losses} | ${r.uniqueLines} | ${r.runId} |`), ''];
  await writeFile(path.join(directory, stage + '.md'), lines.join('\n'));
}
await save();
try {
  for (let index = state.results.length; index < pairs.length; index++) {
    const [a, b] = pairs[index];
    state.active = { index, a, b, startedAt: new Date().toISOString() };
    await save();
    console.log(`Campaign ${stage}: pair ${index + 1}/${pairs.length}: ${a} vs ${b}`);
    const out = await evaluate(['--a', a, '--b', b, '--games', String(games), '--concurrency', '2',
      '--opening-plies', String(settings.openingPlies), '--move-ms', '60000', '--max-plies', String(settings.maxPlies), '--seed', String(settings.seed + index)]);
    const summary = JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8'));
    const records = (await readFile(path.join(out, 'games.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const uniqueLines = new Set(records.map(g => JSON.stringify([g.aSide, g.first, g.moves.map(m => m.action), g.winner, g.termination]))).size;
    state.results.push({ a, b, runId: path.basename(out), summary, uniqueLines });
    delete state.active;
    await save();
    console.log(`Completed ${index + 1}/${pairs.length}: ${a} ${summary.wins}/${summary.draws}/${summary.losses}; failures ${summary.modelFailures}`);
  }
  state.status = 'completed';
  state.finishedAt = new Date().toISOString();
  await save();
} catch (error) {
  state.status = 'interrupted';
  state.error = error.message;
  await save();
  throw error;
}
console.log('Campaign result: ' + filename);
