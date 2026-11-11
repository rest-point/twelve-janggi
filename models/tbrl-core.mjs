// Shared core for the tablebase-guarded RL models (tbrl-*).
// 1. Every legal move is classified exactly with the strict-v2 full tablebase.
// 2. Only moves in the best proven tier are eligible (never give away a draw).
// 3. Among eligible non-winning moves, a small value network trained by league
//    play against the other registered models picks the move that most often
//    leads the opponent into a lost position.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { FastPosition, actionCode } from './pvs-aspiration-rules-v1.mjs';
import { denseIndex } from './full-tablebase-v2.mjs';

const STRIDE = 11878227, PAIRS = 74, PAGE_BYTES = 32768, SHARDS = 8;
const BYTES = PAIRS * STRIDE * 2, PAGES = Math.ceil(BYTES / PAGE_BYTES);

// Same file format as full-tablebase-v2.mjs, with a larger LRU page cache kept
// in off-heap Buffers (the model worker limits only the V8 old generation).
export function openTable(cachePages = 1536, directory = new URL('./full-tablebase/', import.meta.url)) {
  const shards = [];
  try {
    for (let i = 0; i < SHARDS; i++) {
      const fd = openSync(new URL(`strict-v2-${i}.tjb`, directory), 'r');
      const first = Math.floor(PAGES * i / SHARDS), end = Math.floor(PAGES * (i + 1) / SHARDS);
      const shard = { fd, first, end };
      shards.push(shard);
      const header = Buffer.alloc(16);
      readSync(fd, header, 0, 16, 0);
      if (header.toString('ascii', 0, 8) !== 'TJFULL02' || header.readUInt32LE(8) !== first
        || header.readUInt32LE(12) !== end - first) throw new Error('Invalid full tablebase header');
      shard.offsets = Buffer.alloc((end - first + 1) * 4);
      readSync(fd, shard.offsets, 0, shard.offsets.length, 16);
      if (shard.offsets.readUInt32LE(shard.offsets.length - 4) !== fstatSync(fd).size) throw new Error('Invalid full tablebase size');
    }
  } catch (error) {
    for (const { fd } of shards) closeSync(fd);
    throw error;
  }
  const shardOf = new Uint8Array(PAGES);
  for (let i = 0; i < SHARDS; i++) shardOf.fill(i, shards[i].first, shards[i].end);
  const cache = new Map();
  let misses = 0;
  function page(index) {
    let data = cache.get(index);
    if (data !== undefined) {
      cache.delete(index); cache.set(index, data); // refresh recency
      return data;
    }
    misses++;
    const { fd, first, offsets } = shards[shardOf[index]];
    const at = (index - first) * 4, start = offsets.readUInt32LE(at), length = offsets.readUInt32LE(at + 4) - start;
    data = null;
    if (length) {
      const raw = Buffer.allocUnsafe(length);
      if (readSync(fd, raw, 0, length, start) !== length) throw new Error('Short full tablebase read');
      const bytes = Math.min(PAGE_BYTES, BYTES - index * PAGE_BYTES);
      data = inflateRawSync(raw, { maxOutputLength: bytes });
      if (data.length !== bytes) throw new Error('Invalid full tablebase page');
    }
    if (cache.size >= cachePages) cache.delete(cache.keys().next().value);
    cache.set(index, data);
    return data;
  }
  function lookup(index) {
    if (index < 0) return 0;
    const byte = index * 2, data = page(Math.floor(byte / PAGE_BYTES));
    return data ? data.readInt16LE(byte % PAGE_BYTES) : 0;
  }
  return {
    probe(position) { return lookup(denseIndex(position.board, position.hands, position.turn)); },
    probeKey(key) {
      const codes = Array.from(key, ch => ch.charCodeAt(0));
      return lookup(denseIndex(codes.slice(0, 12), codes.slice(12, 18), codes[18]));
    },
    get misses() { return misses; },
    close() { for (const { fd } of shards) closeSync(fd); },
  };
}

// ---- features -------------------------------------------------------------
// Position after our move (opponent to move), seen from the mover ("us"):
// 12 squares x 10 piece planes + 6 hand counts + 8 context values.
export const FEATURES = 12 * 10 + 6 + 8;
export function features(position, us, info, out = new Float32Array(FEATURES)) {
  out.fill(0);
  const flip = us === 1;
  for (let i = 0; i < 12; i++) {
    const p = position.board[flip ? 11 - i : i];
    if (!p) continue;
    out[i * 10 + ((p >> 3) === us ? 0 : 5) + (p & 7) - 1] = 1;
  }
  for (let k = 0; k < 3; k++) {
    out[120 + k] = position.hands[us * 3 + k] / 2;
    out[123 + k] = position.hands[(1 - us) * 3 + k] / 2;
  }
  out[126] = info.repeat >= 2 ? 1 : 0;   // child position seen before
  out[127] = info.repeat >= 3 ? 1 : 0;   // third occurrence
  out[128] = Math.min(1, info.ply / 256);
  out[129] = Math.min(1, info.replies / 24);
  out[130] = info.check ? 1 : 0;
  out[131] = info.capture ? 1 : 0;
  out[132] = info.drop ? 1 : 0;
  out[133] = info.first ? 1 : 0;         // we moved first in this game
  return out;
}

// ---- tiny MLP ---------------------------------------------------------------
// Layout per layer: weight [out][in] row-major, then bias [out]. ReLU hidden,
// linear output (a logit for "we eventually win").
export function mlpLayout(hidden) {
  const sizes = [FEATURES, ...hidden, 1], layers = [];
  let offset = 0;
  for (let i = 0; i + 1 < sizes.length; i++) {
    const w = offset; offset += sizes[i] * sizes[i + 1];
    const b = offset; offset += sizes[i + 1];
    layers.push({ input: sizes[i], output: sizes[i + 1], w, b });
  }
  return { layers, size: offset };
}
export function createMlp(weights, hidden) {
  const { layers, size } = mlpLayout(hidden);
  if (weights.length !== size || !weights.every(Number.isFinite)) throw new Error(`Invalid MLP weights (${weights.length} != ${size})`);
  const buffers = layers.map(l => new Float32Array(l.output));
  return function evaluate(x) {
    let input = x;
    for (let li = 0; li < layers.length; li++) {
      const { input: n, output: m, w, b } = layers[li], out = buffers[li], last = li + 1 === layers.length;
      for (let j = 0; j < m; j++) {
        let s = weights[b + j];
        const row = w + j * n;
        for (let i = 0; i < n; i++) if (input[i] !== 0) s += weights[row + i] * input[i];
        out[j] = last || s > 0 ? s : 0;
      }
      input = out;
    }
    return input[0];
  };
}

// ---- move classification -----------------------------------------------------
const tierOf = value => value === null ? -0.5 : value;

export function classify(state, legalActions, table) {
  const position = new FastPosition(state), us = state.turn, repeated = new Map();
  const first = state.positions.length ? state.positions[0].split('|')[1] === String(us) : state.ply % 2 === 0;
  const children = [];
  for (const action of legalActions) {
    const move = actionCode(action);
    const capture = !action.drop && position.board[action.to] !== 0;
    const undo = position.make(move);
    try {
      const replies = position.actions(), winner = position.winner(replies);
      const child = { action, move, repeat: position.counts.get(undo.key) || 0, replies: winner === null ? replies.length : 0,
        check: winner === null && position.inCheck(position.turn), capture, drop: !!action.drop, oppRepeat: 0 };
      // Can the opponent claim a repetition draw with their very next move?
      if (winner === null) for (const reply of replies) {
        const u = position.make(reply);
        const third = (position.counts.get(u.key) || 0) >= 3;
        position.unmake(u);
        if (third) { child.oppRepeat = 1; break; }
      }
      if (winner !== null) Object.assign(child, { value: winner === 'draw' ? 0 : winner === us ? 1 : -1, distance: 0, certain: true, terminal: true });
      else {
        const raw = table.probe(position);
        if (!raw) Object.assign(child, { value: null, distance: Infinity, certain: false });
        else if (raw === 1) Object.assign(child, { value: 0, distance: Infinity, certain: true });
        else {
          // raw is from the opponent's (side to move) point of view.
          const value = -Math.sign(raw), distance = Math.abs(raw) - 256;
          let certain = true;
          // A board win can turn into a repetition draw if the winning line
          // passes a position already seen twice (same check as v2).
          if (value === 1) for (const [key, count] of position.counts) {
            if (count < 2) continue;
            if (!repeated.has(key)) repeated.set(key, table.probeKey(key));
            const previous = repeated.get(key);
            if (Math.abs(previous) >= 256 && Math.abs(previous) - 256 < distance) { certain = false; break; }
          }
          Object.assign(child, { value, distance, certain });
        }
      }
      child.features = features(position, us, { repeat: child.repeat, ply: state.ply + 1, replies: child.replies,
        check: child.check, capture, drop: child.drop, first });
      children.push(child);
    } finally { position.unmake(undo); }
  }
  return children;
}

export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s >>>= 0; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---- 2-ply trap features (computed only for safe candidates) -----------------
// For the position after our move (opponent to move), probe every opponent
// reply: how many keep the opponent safe, how many lose, and how deep the
// losses are (deep losses are hard for a time-limited search to see).
export const TRAP = 8;
export function trapFeatures(position, table, out = new Float32Array(TRAP)) {
  out.fill(0);
  const replies = position.actions(), n = replies.length;
  if (!n) return out;
  const opp = position.turn;
  let safe = 0, losing = 0, minLoss = Infinity, sumLoss = 0, wins = 0;
  for (const reply of replies) {
    const u = position.make(reply);
    let v = null, d = 0; // value for the opponent: 1 win, 0 draw, -1 loss, null unknown
    try {
      const w = position.winner();
      if (w !== null) v = w === 'draw' ? 0 : w === opp ? 1 : -1;
      else {
        const raw = table.probe(position); // side to move is "us" here
        if (raw === 1) v = 0;
        else if (raw) { v = raw > 0 ? -1 : 1; d = Math.abs(raw) - 256; }
      }
    } finally { position.unmake(u); }
    if (v === -1) { losing++; minLoss = Math.min(minLoss, d); sumLoss += d; }
    else if (v !== null) { safe++; if (v === 1) wins++; }
  }
  out[0] = losing / n;
  out[1] = Math.min(1, safe / 12);
  out[2] = safe === 1 ? 1 : 0;
  out[3] = safe === 2 ? 1 : 0;
  out[4] = losing ? Math.min(1, minLoss / 40) : 0;
  out[5] = losing ? Math.min(1, sumLoss / losing / 40) : 0;
  out[6] = Math.min(1, n / 24);
  out[7] = wins ? 1 : 0;
  return out;
}

// Rebuild a history-free FastPosition from a feature row. Rows are normalized
// so that "us" is side 0 (the board is rotated for side 1, which is a symmetry
// of the rules), and the opponent (side 1) is to move.
export function positionFromFeatures(row) {
  const position = Object.create(FastPosition.prototype);
  position.board = new Int8Array(12);
  position.hands = new Uint8Array(6);
  for (let i = 0; i < 12; i++) for (let k = 0; k < 10; k++) if (row[i * 10 + k]) position.board[i] = (k < 5 ? 0 : 8) + (k % 5) + 1;
  for (let k = 0; k < 3; k++) { position.hands[k] = Math.round(row[120 + k] * 2); position.hands[3 + k] = Math.round(row[123 + k] * 2); }
  position.kings = [position.board.indexOf(1), position.board.indexOf(9)];
  position.turn = 1;
  position.counts = new Map();
  position._winner = null;
  return position;
}

// Filter to the safe candidate set. Returns { tier, eligible }.
export function safeCandidates(children, options = {}) {
  const bestTier = Math.max(...children.map(c => tierOf(c.value)));
  let eligible = children.filter(c => tierOf(c.value) === bestTier);
  if (bestTier === 1) {
    const best = eligible.reduce((a, b) => (a.certain !== b.certain ? a.certain : a.distance <= b.distance) ? a : b);
    return { tier: 1, eligible: [best] };
  }
  if (bestTier === -1) {
    // Lost anyway: prolong as long as possible so the opponent can still err.
    const longest = Math.max(...eligible.map(c => c.distance));
    return { tier: -1, eligible: eligible.filter(c => c.distance === longest) };
  }
  // Do not settle for a repetition draw while another safe move exists, and
  // prefer fresh positions so the game (and the opponent's chances to err) continues.
  const open = eligible.filter(c => !(c.terminal && c.value === 0));
  if (open.length) eligible = open;
  if (options.avoidRepeat !== false) {
    const noClaim = eligible.filter(c => !c.oppRepeat);
    if (noClaim.length) eligible = noClaim;
    const fewest = Math.min(...eligible.map(c => c.repeat));
    eligible = eligible.filter(c => c.repeat === fewest);
  }
  return { tier: bestTier, eligible };
}
