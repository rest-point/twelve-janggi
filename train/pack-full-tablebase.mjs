import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const POSITIONS = 74 * 11878227;
const PAGE_BYTES = 32768;
const SHARDS = 8;
const MAGIC = 'TJFULL02';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node train/pack-full-tablebase.mjs SOURCE NEW_OUTPUT_DIRECTORY');
const input = openSync(source, 'r');
try {
  const header = Buffer.alloc(8), page = Buffer.alloc(PAGE_BYTES);
  if (readSync(input, header) !== 8 || header.toString() !== 'TJFULL01' || fstatSync(input).size !== 8 + 2 * POSITIONS) {
    throw new Error('Invalid dense tablebase');
  }
  mkdirSync(output);
  const pages = Math.ceil(2 * POSITIONS / PAGE_BYTES);
  for (let shard = 0; shard < SHARDS; shard++) {
    const first = Math.floor(pages * shard / SHARDS), end = Math.floor(pages * (shard + 1) / SHARDS);
    const offsets = Buffer.alloc(16 + (end - first + 1) * 4);
    offsets.write(MAGIC);
    offsets.writeUInt32LE(first, 8);
    offsets.writeUInt32LE(end - first, 12);
    const fd = openSync(path.join(output, `strict-v2-${shard}.tjb`), 'wx');
    try {
      let offset = offsets.length;
      for (let i = first; i < end; i++) {
        const length = Math.min(PAGE_BYTES, 2 * POSITIONS - i * PAGE_BYTES);
        if (readSync(input, page, 0, length) !== length) throw new Error('Short dense tablebase page');
        offsets.writeUInt32LE(offset, 16 + (i - first) * 4);
        let nonzero = false;
        for (let b = 0; b < length; b += 2) {
          const value = page.readInt16LE(b);
          if (value !== 0) nonzero = true;
          if (value > 0 && value < 256) page.writeInt16LE(1, b);
        }
        if (!nonzero) continue;
        const compressed = deflateRawSync(page.subarray(0, length), { level: 3 });
        if (writeSync(fd, compressed, 0, compressed.length, offset) !== compressed.length) throw new Error('Short packed tablebase write');
        offset += compressed.length;
      }
      offsets.writeUInt32LE(offset, offsets.length - 4);
      if (writeSync(fd, offsets, 0, offsets.length, 0) !== offsets.length) throw new Error('Short tablebase index write');
      console.log(JSON.stringify({ shard, pages: end - first, bytes: offset }));
    } finally { closeSync(fd); }
  }
} finally { closeSync(input); }
