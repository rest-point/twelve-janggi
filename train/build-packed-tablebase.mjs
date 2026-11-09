import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { initialState } from '../src/engine.js';
import { makeJob, sha256 } from '../bench/common.mjs';
import { FastPosition } from '../models/pvs-aspiration-rules-v1.mjs';
import { MAGIC, KEY_SIZE, RECORD_SIZE, NO_MOVE } from '../models/strict-tablebase-v1.mjs';

function fromKey(key) {
  const kinds = [null, 'king', 'rook', 'bishop', 'pawn', 'hen'];
  const board = Array.from(key.slice(0, 12), ch => {
    const code = ch.charCodeAt(0);
    return code ? { side: code >> 3, kind: kinds[code & 7] } : null;
  });
  const hands = [0, 1].map(side => kinds.slice(2, 5).flatMap((kind, i) =>
    Array(key.charCodeAt(12 + side * 3 + i)).fill(kind)));
  return new FastPosition({ board, hands, turn: key.charCodeAt(18), winner: null, positions: [] });
}

export function buildTablebase(roots, maxPositions) {
  const keys = [], ids = new Map(), parents = [];
  const remaining = new Uint8Array(maxPositions), value = new Int8Array(maxPositions);
  const distance = new Uint32Array(maxPositions), best = new Uint8Array(maxPositions).fill(NO_MOVE);
  const queue = [];
  let frontierEdges = 0;
  function add(key) {
    if (ids.has(key)) return ids.get(key);
    if (keys.length === maxPositions) return -1;
    const id = keys.length;
    ids.set(key, id); keys.push(key); parents.push([]);
    return id;
  }
  for (const state of roots) add(new FastPosition(state).key());
  for (let id = 0; id < keys.length; id++) {
    const position = fromKey(keys[id]);
    const actions = position.actions(), winner = position.winner(actions);
    if (winner !== null) {
      value[id] = winner === position.turn ? 1 : -1;
      queue.push(id);
      continue;
    }
    remaining[id] = actions.length;
    for (const move of actions) {
      const undo = position.make(move), child = add(undo.key);
      position.unmake(undo);
      if (child < 0) frontierEdges++;
      else parents[child].push(id * 256 + move);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const child = queue[cursor];
    for (const edge of parents[child]) {
      const parent = Math.floor(edge / 256);
      if (value[parent]) continue;
      // A win needs one losing reply. A loss requires all legal moves to
      // lead to wins, including any edges outside the explored graph.
      if (value[child] > 0 && --remaining[parent]) continue;
      value[parent] = -value[child];
      distance[parent] = distance[child] + 1;
      best[parent] = edge % 256;
      queue.push(parent);
    }
  }
  const bytes = Buffer.alloc(MAGIC.length + queue.length * RECORD_SIZE);
  bytes.write(MAGIC);
  const counts = { positions: keys.length, wins: 0, losses: 0, unknown: keys.length - queue.length,
    frontierEdges, maxProofPlies: 0, proofs50Plus: 0 };
  queue.forEach((id, index) => {
    const offset = MAGIC.length + index * RECORD_SIZE;
    bytes.write(keys[id], offset, KEY_SIZE, 'latin1');
    bytes.writeInt32LE(value[id] * (distance[id] + 1), offset + KEY_SIZE);
    bytes[offset + KEY_SIZE + 4] = best[id];
    counts[value[id] === 1 ? 'wins' : 'losses']++;
    counts.maxProofPlies = Math.max(counts.maxProofPlies, distance[id]);
    if (distance[id] >= 50) counts.proofs50Plus++;
  });
  return { bytes, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['out', 'max-positions', 'seed', 'openings']
    .map(name => [name, { type: 'string' }])) });
  if (!values.out) throw new Error('Use --out with a new file under artifacts');
  const out = path.resolve(values.out), maxPositions = Number(values['max-positions'] ?? 250000);
  const seed = Number(values.seed ?? 271903), openings = Number(values.openings ?? 64);
  for (const [n, min, max] of [[maxPositions, 10, 5000000], [seed, 0, 2 ** 32 - 1], [openings, 0, 10000]]) {
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid tablebase limits');
  }
  if (!out.startsWith(path.resolve('artifacts') + path.sep)) throw new Error('Output must be inside artifacts');
  const roots = [initialState(0), initialState(1)];
  for (let i = 0; i < openings; i++) roots.push(makeJob(i * 2, { seed, openingPlies: 4 + (i % 13) }).startState);
  const { bytes, counts } = buildTablebase(roots, maxPositions);
  if (!counts.wins && !counts.losses) throw new Error('No positions proved, increase --max-positions');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ ...counts, seed, openings, sha256: sha256(bytes) }));
}
