import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyAction, legalActions } from '../src/engine.js';
import { BLUE_FIRST_POLICY, makeJob, rng, seedOf, sha256 } from '../bench/common.mjs';
import { features, canonAction, LAYOUT, initWeights } from '../models/azero-core.mjs';
import { FastPosition, actionCode, decodeAction } from '../models/pvs-aspiration-rules-v1.mjs';
import { createPackedEvaluator } from '../models/packed-gemm-policy-value-v2.mjs';
import { searchBatch } from '../models/packed-puct-search-v2.mjs';
import { loadTablebase, searchWithTablebase } from '../models/packed-tablebase-v1.mjs';
import { think as champion } from '../models/azero-v2.mjs';
import { think as classical } from '../models/stockjang-v1.mjs';
import { think as mcts } from '../models/team-mcts-v1.mjs';
import { think as minimax } from '../models/minimax.mjs';
import { think as packed } from '../models/packed-gemm-puct-v2.mjs';
import { backward } from './backprop.mjs';

function readWeights(file) {
  const bytes = readFileSync(file);
  if (bytes.length !== LAYOUT.size * 4) throw new Error('Wrong checkpoint size');
  const weights = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!weights.every(Number.isFinite)) throw new Error('Nonfinite checkpoint');
  return weights;
}

function policySample(state, legal, root, rng, explore, qWeight) {
  const position = new FastPosition(state);
  const encoded = { b: Int8Array.from(position.board, piece => piece > 8 ? piece - 3 : piece),
    h: position.hands, t: position.turn };
  const codes = legal.map(actionCode);
  const visits = new Map(root.actions.map((action, i) => [
    action, (root.visits[i] || 0) * Math.exp(qWeight * (root.values[i] ?? 0.5)),
  ]));
  const counts = codes.map(action => root.proven === 1 ? Number(action === root.chosen) : visits.get(action) || 0);
  let total = counts.reduce((a, b) => a + b, 0);
  if (!total) { counts[codes.indexOf(root.chosen)] = 1; total = 1; }
  const target = counts.map(count => count / total);
  let selected = root.chosen;
  if (explore && root.proven === null) {
    let ticket = rng() * total;
    for (let i = 0; i < counts.length; i++) {
      ticket -= counts[i];
      if (ticket < 0) { selected = codes[i]; break; }
    }
  }
  return { action: decodeAction(selected), sample: { f: features(encoded, position.counts.get(position.key())),
    a: codes.map(action => canonAction(action, state.turn)), p: target, side: state.turn, proof: root.proven } };
}

function gameRunner(options, weights, tablebaseBytes) {
  const tablebase = tablebaseBytes ? loadTablebase(tablebaseBytes) : null;
  const pool = [
    ['champion', champion, { sims: 800 }],
    ['stockjang', classical, { maxDepth: 9, maxNodes: 4500, quiescenceDepth: 3, maxTimeMs: 1500 }],
    ['mcts', mcts, { maxSimulations: 192, rolloutPlies: 256, thinkMs: 500 }],
    ['minimax', minimax, { difficulty: 'normal' }],
    ['packed', packed, { simulations: 192, rootProofNodes: 1200, leafProofNodes: 16, maxTimeMs: 55000 }],
  ];
  return index => {
    const evaluate = createPackedEvaluator(weights);
    const random = rng(seedOf(options.seed, 'play', index));
    const job = makeJob(index, { seed: options.seed, startPolicy: BLUE_FIRST_POLICY,
      openingPlies: options.mode === 'eval' ? options.opening : 2 + (Math.floor(index / 4) % 7) });
    let state = job.startState;
    const block = Math.floor(index / 4), slot = block % 8;
    // Each opponent assignment covers a full color/first-player block.
    const opponent = options.mode === 'eval' ? pool[0] : slot < 6 - options.championBlocks ? null
      : slot < 6 ? pool[0] : slot === 6 ? pool[1] : pool[2 + Math.floor(block / 8) % 3];
    const samples = [], latency = [];
    let tablebaseWins = 0, tablebaseFilters = 0, tablebase50Plus = 0;
    for (let ply = 0; state.ply < 256 && state.winner === null; ply++) {
      const legal = legalActions(state);
      const request = { state, legalActions: legal, budgetMs: 60000 };
      let action;
      if (opponent && state.turn !== job.aSide) {
        action = opponent[1]({ ...request, config: opponent[2] }).action;
      } else {
        const training = options.mode === 'train';
        const full = !training || ply < 5 || random() < 0.55;
        const start = performance.now();
        const searchRequest = { ...request, config: {
          simulations: full ? options.sims : 48, batchSize: options.batchSize,
          rootProofNodes: options.proofNodes, leafProofNodes: options.leafProof,
          replyProofNodes: options.replyProof, rootCoverage: options.coverage, cInitRoot: options.cRoot,
          rootValuePenalty: options.rootValuePenalty,
          proofDepth: 12, maxTimeMs: training ? 55000 : options.timeMs,
        } };
        const result = tablebase ? searchWithTablebase(searchRequest, evaluate, tablebase)
          : searchBatch(searchRequest, evaluate);
        if (result.tablebase?.direct) {
          tablebaseWins++;
          if (result.tablebase.distance >= 50) tablebase50Plus++;
        }
        if (result.tablebase?.filtered) tablebaseFilters++;
        if (training) {
          const sampled = policySample(state, legal, result.root, random, ply < 8 || random() < 0.08, options.qWeight);
          action = sampled.action;
          if (full || sampled.sample.proof !== null) samples.push(sampled.sample);
        } else { action = result.action; latency.push(performance.now() - start); }
      }
      state = applyAction(state, action, false);
    }
    const winner = state.winner ?? 'draw';
    for (const row of samples) {
      row.z = row.proof ?? (winner === 'draw' ? 0 : winner === row.side ? 1 : -1);
      delete row.side;
      delete row.proof;
    }
    return { index, samples, latency, opening: job.startState.positions.at(-1), opponent: opponent?.[0] ?? 'self',
      ...(tablebase ? { tablebaseWins, tablebaseFilters, tablebase50Plus } : {}),
      plies: state.ply, outcome: winner === 'draw' ? 'draws' : winner === job.aSide ? 'wins' : 'losses' };
  };
}

async function collect(options, weights, tablebaseBytes) {
  const results = [];
  const workers = [];
  let next = 0, done = 0;
  try {
    await new Promise((resolve, reject) => {
      for (let i = 0; i < Math.min(options.workers, options.games); i++) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { options, weights, tablebaseBytes } });
        workers.push(worker);
        worker.once('error', reject);
        worker.once('exit', code => { if (done < options.games) reject(new Error(`Training worker exited with ${code}`)); });
        worker.on('message', game => {
          results[game.index] = game;
          done++;
          if (done % Math.max(4, Math.floor(options.games / 4)) === 0 || done === options.games) console.log(`${options.mode} ${done}/${options.games}`);
          if (done === options.games) resolve();
          else if (next < options.games) worker.postMessage(next++);
        });
        worker.postMessage(next++);
      }
    });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  return results;
}

function fit(weights, rows, options) {
  const m = new Float64Array(weights.length), v = new Float64Array(weights.length), grad = new Float64Array(weights.length);
  const random = rng(seedOf(options.seed, 'optimizer')), indices = rows.map((_, i) => i);
  const flip = sq => (2 - (sq >> 2)) * 4 + sq % 4;
  const mirrorFeature = f => f < 120 ? flip(Math.floor(f / 10)) * 10 + f % 10 : f;
  const mirrorAction = a => a < 144 ? flip(Math.floor(a / 12)) * 12 + flip(a % 12) : a - a % 12 + flip(a % 12);
  let steps = 0, samples = 0, policy = 0, value = 0;
  for (let epoch = 0; epoch < options.epochs; epoch++) {
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let start = 0; start < indices.length; start += 96) {
      const end = Math.min(start + 96, indices.length);
      grad.fill(0);
      for (let i = start; i < end; i++) {
        const row = rows[indices[i]], mirror = random() < 0.5;
        const loss = backward(weights, grad, mirror ? row.f.map(mirrorFeature) : row.f,
          mirror ? row.a.map(mirrorAction) : row.a, row.p, row.z);
        samples++;
        policy += loss.policyLoss;
        value += loss.valueLoss;
      }
      steps++;
      const c1 = 1 - 0.9 ** steps, c2 = 1 - 0.999 ** steps;
      for (let i = 0; i < weights.length; i++) {
        const d = grad[i] / (end - start) + 1e-5 * weights[i];
        m[i] = 0.9 * m[i] + 0.1 * d;
        v[i] = 0.999 * v[i] + 0.001 * d * d;
        weights[i] -= options.lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
      }
    }
  }
  if (!weights.every(Number.isFinite)) throw new Error('Training produced nonfinite weights');
  return { steps, policyLoss: policy / samples, valueLoss: value / samples };
}

if (!isMainThread) {
  const play = gameRunner(workerData.options, workerData.weights, workerData.tablebaseBytes);
  parentPort.on('message', index => parentPort.postMessage(play(index)));
} else {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['mode','start','out','games','workers','sims','seed','epochs','lr','opening','time-ms','batch-size','proof-nodes','leaf-proof',
      'reply-proof','coverage','q-weight','c-root','replay','champion-blocks','root-value-penalty','tablebase']
      .map(name => [name, { type: 'string' }])) });
  const options = { mode: values.mode ?? 'train', games: Number(values.games ?? 256), workers: Number(values.workers ?? 4),
    sims: Number(values.sims ?? 144), seed: Number(values.seed ?? 20261107), epochs: Number(values.epochs ?? 2),
    lr: Number(values.lr ?? 0.00015), opening: Number(values.opening ?? 6), timeMs: Number(values['time-ms'] ?? 180),
    batchSize: Number(values['batch-size'] ?? 8),
    proofNodes: Number(values['proof-nodes'] ?? (values.mode === 'eval' ? 5000 : 1400)),
    leafProof: Number(values['leaf-proof'] ?? (values.mode === 'eval' ? 40 : 20)),
    replyProof: Number(values['reply-proof'] ?? 0), coverage: Number(values.coverage ?? 0),
    qWeight: Number(values['q-weight'] ?? 0), cRoot: Number(values['c-root'] ?? 1.16),
    championBlocks: Number(values['champion-blocks'] ?? 2), rootValuePenalty: Number(values['root-value-penalty'] ?? -1) };
  const bounds = {
    games: [4, 50000], workers: [1, 32], sims: [1, 10000], seed: [0, 2 ** 32 - 1], epochs: [1, 100],
    opening: [0, 32], timeMs: [1, 55000], batchSize: [1, 32], proofNodes: [0, 50000],
    leafProof: [0, 1000], replyProof: [0, 5000], coverage: [0, 8], championBlocks: [0, 6],
  };
  for (const [name, [min, max]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(options[name]) || options[name] < min || options[name] > max) throw new Error(`Invalid ${name}`);
  }
  if (!['train','eval'].includes(options.mode) || options.games % 4
      || !(options.lr > 0 && options.lr <= 0.01) || !(options.qWeight >= 0 && options.qWeight <= 16)
      || !(options.cRoot >= 0 && options.cRoot <= 5) || !(options.rootValuePenalty >= -1 && options.rootValuePenalty <= 1)) throw new Error('Invalid experiment options');
  const output = path.resolve(values.out ?? 'artifacts/packed-league');
  if (!output.startsWith(path.resolve('artifacts') + path.sep)) throw new Error('Output must be inside artifacts');
  mkdirSync(output, { recursive: true });
  const weights = values.start === 'random' ? initWeights(rng(seedOf(options.seed, 'init'))) : readWeights(values.start ?? 'models/azero-v2.bin');
  const inputHash = sha256(Buffer.from(weights.buffer));
  const tablebaseBytes = values.tablebase ? readFileSync(values.tablebase) : null;
  const sources = Object.fromEntries([
    'train/packed-league.mjs', 'train/backprop.mjs', 'src/engine.js', 'bench/common.mjs',
    'models/packed-puct-search-v2.mjs', 'models/packed-gemm-policy-value-v2.mjs', 'models/azero-v2.bin',
    'models/azero-v2.mjs', 'models/azero-core.mjs', 'models/stockjang-v1.mjs', 'models/team-mcts-v1.mjs',
    'models/team-search-common.mjs', 'models/minimax.mjs', 'models/packed-gemm-puct-v2.mjs', 'models/packed-gemm-puct-v2.bin',
    'models/dfpn-proof-v1.mjs', 'models/pvs-aspiration-rules-v1.mjs',
    ...(tablebaseBytes ? ['models/packed-tablebase-v1.mjs', 'models/strict-tablebase-v1.mjs'] : []),
  ].map(file => [file, sha256(readFileSync(file))]));
  const replay = values.replay ? values.replay.split(',').map(file => {
    const bytes = readFileSync(file);
    return { file, hash: sha256(bytes), rows: bytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)) };
  }) : [];
  const started = performance.now();
  const games = await collect(options, weights, tablebaseBytes);
  const rows = games.flatMap(game => game.samples);
  const result = { options, inputHash, sources, replay: replay.map(({ file, hash, rows }) => ({ file, hash, samples: rows.length })),
    samples: rows.length, wins: 0, draws: 0, losses: 0,
    openings: new Set(games.map(g => g.opening)).size };
  for (const game of games) result[game.outcome]++;
  result.scoreRate = (result.wins + result.draws / 2) / games.length;
  if (tablebaseBytes) result.tablebase = {
    hash: sha256(tablebaseBytes),
    wins: games.reduce((sum, game) => sum + game.tablebaseWins, 0),
    filters: games.reduce((sum, game) => sum + game.tablebaseFilters, 0),
    proofs50Plus: games.reduce((sum, game) => sum + game.tablebase50Plus, 0),
  };
  if (options.mode === 'train') {
    if (!rows.length) throw new Error('Empty training dataset');
    result.training = fit(weights, [...replay.flatMap(item => item.rows), ...rows], options);
    result.outputHash = sha256(Buffer.from(weights.buffer));
    writeFileSync(path.join(output, 'weights.bin'), Buffer.from(weights.buffer), { flag: 'wx' });
    writeFileSync(path.join(output, 'samples.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  }
  const timings = games.flatMap(game => game.latency).sort((a, b) => a - b);
  if (timings.length) result.p50Ms = timings[Math.floor(timings.length / 2)];
  result.seconds = (performance.now() - started) / 1000;
  writeFileSync(path.join(output, 'games.jsonl'), games.map(({ samples, ...game }) => JSON.stringify(game)).join('\n') + '\n', { flag: 'wx' });
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
