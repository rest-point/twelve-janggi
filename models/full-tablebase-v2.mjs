import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const STRIDE = 11878227, PAIRS = 74, PAGE_BYTES = 32768, SHARDS = 8;
const BYTES = PAIRS * STRIDE * 2, PAGES = Math.ceil(BYTES / PAGE_BYTES);
const Pop = new Uint8Array(4096), First = new Uint8Array(4096), Pair = new Int8Array(144).fill(-1);
const PawnCount = new Int32Array(11), BishopCount = new Int32Array(11);
const choose2 = n => n * (n - 1) / 2;
for (let i = 1; i < 4096; i++) {
  Pop[i] = Pop[i >> 1] + (i & 1);
  First[i] = i & 1 ? 0 : First[i >> 1] + 1;
}
let nextPair = 0;
for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
  if (Math.abs(a % 4 - b % 4) > 1 || Math.abs((a >> 2) - (b >> 2)) > 1) Pair[a * 12 + b] = nextPair++;
}
for (let n = 0; n <= 10; n++) {
  PawnCount[n] = 3 + 8 * n + 16 * choose2(n);
  BishopCount[n] = 3 * PawnCount[n] + (n >= 1 ? 4 * n * PawnCount[n - 1] : 0)
    + (n >= 2 ? 4 * choose2(n) * PawnCount[n - 2] : 0);
}
if (nextPair !== PAIRS || 3 * BishopCount[10] + 40 * BishopCount[9] + 180 * BishopCount[8] !== STRIDE) {
  throw new Error('Full tablebase index dimensions disagree');
}

// The table is normalized to the side to move. Index only positions with
// exactly the standard material, including captured pieces in both hands.
export function denseIndex(board, hands, turn) {
  const squares = [0, 0, 0];
  let king = -1, enemy = -1;
  const piece = square => {
    const p = board[turn ? 11 - square : square];
    return p ? p ^ (turn * 8) : 0;
  };
  for (let i = 0; i < 12; i++) {
    const p = piece(i), kind = p & 7;
    if (p === 1) king = i;
    else if (p === 9) enemy = i;
    else if (p) squares[Math.min(kind - 2, 2)] |= 1 << i;
  }
  if (king < 0 || enemy < 0) return -1;
  const pair = Pair[king * 12 + enemy];
  if (pair < 0 || squares.some((mask, i) => Pop[mask] + hands[i] + hands[i + 3] !== 2)) return -1;
  function ordinal(mask, free, kind) {
    const held = hands[turn * 3 + kind];
    if (!mask) return held;
    const a = First[mask], rest = mask & (mask - 1);
    const variants = kind === 2 ? 4 : 2;
    const variant = p => kind === 2 ? 2 * (p >> 3) + Number((p & 7) === 5) : p >> 3;
    const ai = Pop[free & ((1 << a) - 1)], av = variant(piece(a));
    if (!rest) return (ai * variants + av) * 2 + held;
    const b = First[rest], bi = Pop[free & ((1 << b) - 1)];
    return ((choose2(bi) + ai) * variants + av) * variants + variant(piece(b));
  }
  let free = 4095 ^ ((1 << king) | (1 << enemy));
  const [rook, bishop, pawn] = squares, n = Pop[rook], count = Pop[bishop];
  let rank = ordinal(rook, free, 0) * BishopCount[10 - n];
  if (n >= 1) rank += 3 * BishopCount[10];
  if (n === 2) rank += 40 * BishopCount[9];
  free ^= rook;
  const m = 10 - n;
  rank += ordinal(bishop, free, 1) * PawnCount[m - count];
  if (count >= 1) rank += 3 * PawnCount[m];
  if (count === 2) rank += 4 * m * PawnCount[m - 1];
  rank += ordinal(pawn, free ^ bishop, 2);
  if (pawn) rank += 3;
  if (Pop[pawn] === 2) rank += 8 * (m - count);
  return pair * STRIDE + rank;
}

function read(fd, bytes, offset) {
  const buffer = Buffer.allocUnsafe(bytes);
  if (readSync(fd, buffer, 0, bytes, offset) !== bytes) throw new Error('Short full tablebase read');
  return buffer;
}

export function openFullTablebase(directory = new URL('./full-tablebase/', import.meta.url)) {
  const shards = [], cache = new Map();
  try {
    for (let i = 0; i < SHARDS; i++) {
      const fd = openSync(new URL(`strict-v2-${i}.tjb`, directory), 'r');
      const first = Math.floor(PAGES * i / SHARDS), end = Math.floor(PAGES * (i + 1) / SHARDS);
      const shard = { fd, first, end };
      shards.push(shard);
      const header = read(fd, 16, 0), size = fstatSync(fd).size;
      if (header.toString('ascii', 0, 8) !== 'TJFULL02' || header.readUInt32LE(8) !== first
        || header.readUInt32LE(12) !== end - first) throw new Error('Invalid full tablebase header');
      shard.offsets = read(fd, (end - first + 1) * 4, 16);
      let previous = 16 + shard.offsets.length;
      for (let at = 0; at < shard.offsets.length; at += 4) {
        const offset = shard.offsets.readUInt32LE(at);
        if (offset < previous || offset > size || offset - previous > PAGE_BYTES + 1024) throw new Error('Invalid full tablebase offsets');
        previous = offset;
      }
      if (previous !== size) throw new Error('Invalid full tablebase size');
    }
  } catch (error) {
    for (const { fd } of shards) closeSync(fd);
    throw error;
  }
  function lookup(index) {
    if (index < 0) return 0;
    const byte = index * 2, page = Math.floor(byte / PAGE_BYTES);
    let data = cache.get(page);
    if (data === undefined) {
      const { fd, first, offsets } = shards.find(shard => page < shard.end);
      const at = (page - first) * 4, start = offsets.readUInt32LE(at), length = offsets.readUInt32LE(at + 4) - start;
      data = null;
      if (length) {
        const bytes = Math.min(PAGE_BYTES, BYTES - page * PAGE_BYTES);
        data = inflateRawSync(read(fd, length, start), { maxOutputLength: bytes });
        if (data.length !== bytes) throw new Error('Invalid full tablebase page');
      }
      if (cache.size === 128) cache.delete(cache.keys().next().value);
      cache.set(page, data);
    }
    return data?.readInt16LE(byte % PAGE_BYTES) ?? 0;
  }
  return {
    probe(position) { return lookup(denseIndex(position.board, position.hands, position.turn)); },
    probeKey(key) {
      const codes = Array.from(key, ch => ch.charCodeAt(0));
      return lookup(denseIndex(codes.slice(0, 12), codes.slice(12, 18), codes[18]));
    },
    close() { for (const { fd } of shards) closeSync(fd); },
  };
}
