// node train/train.mjs --minutes 60 --workers 8 [--sims 200] [--resume file.bin] [--worker selfplay|gumbel] [--frozen file.bin] [--lr 1e-3]
import { Worker } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { initWeights } from '../models/azero-core.mjs';
import { backward } from './backprop.mjs';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(x => x.trim().split(' ')));
const minutes = Number(args.minutes || 60), workers = Number(args.workers || 8), sims = Number(args.sims || 200), out = args.out || 'artifacts/azero', baseLr = Number(args.lr || 1e-3);
const BATCH = 256, REUSE = 6, CAPACITY = 1_000_000, MIN_BUFFER = 5000, BETA1 = 0.9, BETA2 = 0.999;
mkdirSync(out, { recursive: true });
const start = initWeights();
if (args.resume) start.set(new Float32Array(readFileSync(args.resume).buffer.slice(0)));
const sab = new SharedArrayBuffer(start.byteLength), w = new Float32Array(sab);
w.set(start);
const m1 = new Float64Array(w.length), m2 = new Float64Array(w.length), g = new Float64Array(w.length);

// y-mirror is a true symmetry of the rules; x stays, so the canonical direction holds.
const MIRROR = Array.from({ length: 12 }, (_, i) => (2 - (i >> 2)) * 4 + i % 4);
const mirrorFeature = f => (f < 120 ? MIRROR[f / 10 | 0] * 10 + f % 10 : f);
const mirrorAction = a => (a < 144 ? MIRROR[a / 12 | 0] * 12 + MIRROR[a % 12] : 144 + ((a - 144) / 12 | 0) * 12 + MIRROR[(a - 144) % 12]);

const buffer = [];
let write = 0, generated = 0, games = 0, plies = 0, draws = 0, frozenGames = 0, frozenScore = 0;
const pool = Array.from({ length: workers }, () => {
  const worker = new Worker(new URL(`./${args.worker || 'selfplay'}-worker.mjs`, import.meta.url), { workerData: { weights: sab, sims, frozen: args.frozen } });
  worker.on('message', r => {
    for (const x of r.samples) { if (buffer.length < CAPACITY) buffer.push(x); else buffer[write++ % CAPACITY] = x; }
    generated += r.samples.length; games++; plies += r.plies; draws += r.draw ? 1 : 0;
    if (r.frozenScore !== null && r.frozenScore !== undefined) { frozenGames++; frozenScore += r.frozenScore; }
  });
  worker.on('error', e => { console.error(e); process.exit(1); });
  return worker;
});

let steps = 0, pl = 0, vl = 0, lastLog = Date.now(), lastSave = Date.now(), lastGames = 0, lastPlies = 0, lastDraws = 0;
const began = Date.now(), lr = () => { const f = (Date.now() - began) / (minutes * 60000); return baseLr * (f < 0.5 ? 1 : f < 0.8 ? 0.3 : 0.1); };
const save = name => writeFileSync(`${out}/${name}.bin`, Buffer.from(w.slice().buffer));
function trainStep() {
  g.fill(0);
  for (let n = 0; n < BATCH; n++) {
    const x = buffer[Math.floor(Math.random() * buffer.length)], flip = Math.random() < 0.5;
    const loss = backward(w, g, flip ? Array.from(x.f, mirrorFeature) : x.f, flip ? Array.from(x.a, mirrorAction) : x.a, x.p, x.z);
    pl += loss.policyLoss; vl += loss.valueLoss;
  }
  steps++;
  const rate = lr(), c1 = 1 - BETA1 ** steps, c2 = 1 - BETA2 ** steps;
  for (let i = 0; i < w.length; i++) {
    const d = g[i] / BATCH + 1e-5 * w[i];
    m1[i] = BETA1 * m1[i] + (1 - BETA1) * d;
    m2[i] = BETA2 * m2[i] + (1 - BETA2) * d * d;
    w[i] -= rate * (m1[i] / c1) / (Math.sqrt(m2[i] / c2) + 1e-8);
  }
}
function log() {
  const dg = games - lastGames || 1;
  const line = { min: +((Date.now() - began) / 60000).toFixed(1), games, generated, steps, policy: +(pl / (BATCH * 200 || 1)).toFixed(3), value: +(vl / (BATCH * 200 || 1)).toFixed(3), avgPlies: +((plies - lastPlies) / dg).toFixed(1), drawRate: +((draws - lastDraws) / dg).toFixed(3), vsFrozen: frozenGames ? +(frozenScore / frozenGames).toFixed(3) : null };
  console.log(JSON.stringify(line));
  appendFileSync(`${out}/log.jsonl`, JSON.stringify(line) + '\n');
  frozenGames = frozenScore = 0; pl = vl = 0; lastGames = games; lastPlies = plies; lastDraws = draws;
}
while (Date.now() - began < minutes * 60000) {
  if (buffer.length >= MIN_BUFFER && steps * BATCH < generated * REUSE) {
    trainStep();
    if (steps % 200 === 0) log();
  } else await new Promise(r => setTimeout(r, 50));
  if (steps % 8 === 0) await new Promise(r => setImmediate(r));
  if (Date.now() - lastSave > 10 * 60000) { lastSave = Date.now(); save(`step-${steps}`); }
}
save('final');
log();
await Promise.all(pool.map(x => x.terminate()));
