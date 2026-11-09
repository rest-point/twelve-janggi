import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { applyAction, initialState, legalActions } from '../src/engine.js';
import { rng } from '../bench/common.mjs';
import { actionCode } from '../models/pvs-aspiration-rules-v1.mjs';

const kinds = ['', 'king', 'rook', 'bishop', 'pawn', 'hen'];

export function keyOf({ board, hands, turn }) {
  let key = 0n;
  for (const [i, piece] of board.entries()) {
    if (!piece) continue;
    const code = kinds.indexOf(piece.kind) + 8 * (piece.side ^ turn);
    key |= BigInt(code) << BigInt(4 * (turn ? 11 - i : i));
  }
  for (let side = 0; side < 2; side++) {
    for (const kind of hands[side]) key += 1n << BigInt(48 + 6 * (side ^ turn) + 2 * (kinds.indexOf(kind) - 2));
  }
  return key.toString(16);
}

export function readBatch(exe, args, keys) {
  const result = spawnSync(exe, args, { input: keys.join('\n') + '\n', encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Solver exited ${result.status}`);
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, keys.length);
  return lines;
}

export function verify(exe, file, sampleCount = 4000) {
  const random = rng(271909), samples = new Map(), positions = [initialState(), initialState(1)];
  let state = positions[0];
  while (samples.size < sampleCount) {
    const key = keyOf(state);
    if (!samples.has(key)) samples.set(key, state);
    if (state.winner !== null) state = positions[Math.floor(random() * positions.length)];
    else {
      const actions = legalActions(state);
      const child = applyAction(state, actions[Math.floor(random() * actions.length)], false);
      // The closed graph folds repetitions for offline reachability. The
      // official oracle still applies all static and terminal rules per edge.
      state = child.winner === 'draw' ? positions[Math.floor(random() * positions.length)]
        : { ...child, positions: child.positions.slice(-1) };
    }
  }
  const entries = [...samples], reverse = new Map(), query = new Set(samples.keys()), expectedChildren = new Map();
  const lines = readBatch(exe, ['rules'], entries.map(([key]) => key));
  let edges = 0, terminals = 0;
  entries.forEach(([key, current], i) => {
    const [pair, rank, winner, ...actual] = lines[i].split(' ');
    const index = `${pair}/${rank}`;
    assert.ok(!reverse.has(index), `Dense index collision at ${index}`);
    reverse.set(index, key);
    const terminal = current.winner === null ? 0 : current.winner === current.turn ? 1 : -1;
    assert.equal(Number(winner), terminal, `Terminal mismatch for ${key}`);
    const expected = legalActions(current).map(action => {
      const code = actionCode(action);
      const normalizedCode = current.turn ? code >= 144 ? code - code % 12 + 11 - code % 12 : 143 - code : code;
      const childKey = keyOf(applyAction(current, action, false));
      query.add(childKey);
      return [normalizedCode, childKey];
    });
    assert.deepEqual(actual.sort(), expected.map(([code, child]) => `${code}:${child}`).sort(), `Legal edge mismatch for ${key}`);
    expectedChildren.set(key, expected);
    edges += actual.length;
    if (terminal) terminals++;
  });
  const principal = [];
  if (file) {
    const keys = [...query], values = new Map(keys.map((key, i) => [key, i]));
    const probes = readBatch(exe, ['probe', file], keys);
    function value(key) {
      const [result, rank] = probes[values.get(key)].split('/');
      assert.notEqual(result, 'unknown', `Missing reachable key ${key}`);
      return [result, Number(rank ?? 0)];
    }
    for (const [key, current] of entries) {
      const [result, rank] = value(key);
      if (current.winner !== null) {
        assert.deepEqual([result, rank], [current.winner === current.turn ? 'win' : 'loss', 0]);
        continue;
      }
      const children = expectedChildren.get(key).map(([, child]) => value(child));
      const losing = children.filter(([status]) => status === 'loss');
      if (losing.length) assert.deepEqual([result, rank], ['win', 1 + Math.min(...losing.map(([, depth]) => depth))], key);
      else if (children.every(([status]) => status === 'win')) assert.deepEqual([result, rank], ['loss', 1 + Math.max(...children.map(([, depth]) => depth))], key);
      else assert.equal(result, 'draw', key);
    }

    for (const first of [0, 1]) {
      let current = initialState(first);
      const [result, rank] = value(keyOf(current));
      while (current.winner === null && current.ply < (result === 'draw' ? 512 : rank)) {
        const actions = legalActions(current), children = actions.map(action => applyAction(current, action, false));
        const remaining = rank - current.ply - 1;
        const expected = result === 'draw' ? 'draw' : (current.ply % 2 === 0) === (result === 'win') ? 'loss' : 'win';
        const statuses = readBatch(exe, ['probe', file], children.map(keyOf));
        const next = children.find((child, index) => {
          if (child.winner === 'draw') return result === 'draw';
          const [status, distance] = statuses[index].split('/');
          return status === expected && (result === 'draw' || Number(distance) === remaining);
        });
        assert.ok(next, `No optimal continuation after ${current.ply} plies for starter ${first}`);
        current = next;
      }
      if (result !== 'draw') {
        assert.equal(current.ply, rank);
        assert.equal(current.winner, result === 'win' ? first : 1 - first);
      } else if (current.winner !== null) assert.equal(current.winner, 'draw');
      principal.push({ first, result, plies: current.ply, winner: current.winner });
    }
  }
  console.log(JSON.stringify({ states: samples.size, edges, terminals, tableVerified: Boolean(file), principal }));
}

function verifyPacked(file, directory) {
  const fd = openSync(file, 'r'), pageBytes = 32768, shards = 8;
  const raw = Buffer.alloc(pageBytes), zero = Buffer.alloc(pageBytes);
  const read = (handle, bytes, size, offset) => assert.equal(readSync(handle, bytes, 0, size, offset), size);
  let checked = 0;
  try {
    const rawHeader = Buffer.alloc(8), bytes = fstatSync(fd).size - rawHeader.length;
    const pages = Math.ceil(bytes / pageBytes);
    read(fd, rawHeader, rawHeader.length, 0);
    assert.equal(rawHeader.toString(), 'TJFULL01');
    assert.equal(bytes, 2 * 74 * 11878227);
    for (let i = 0; i < shards; i++) {
      const packed = openSync(path.join(directory, `strict-v2-${i}.tjb`), 'r');
      try {
        const header = Buffer.alloc(16);
        read(packed, header, header.length, 0);
        assert.equal(header.toString('ascii', 0, 8), 'TJFULL02');
        const start = header.readUInt32LE(8), count = header.readUInt32LE(12);
        assert.equal(start, Math.floor(pages * i / shards));
        assert.equal(start + count, Math.floor(pages * (i + 1) / shards));
        const offsets = Buffer.alloc((count + 1) * 4);
        read(packed, offsets, offsets.length, header.length);
        assert.equal(offsets.readUInt32LE(0), header.length + offsets.length);
        assert.equal(offsets.readUInt32LE(count * 4), fstatSync(packed).size);
        for (let p = 0; p < count; p++) {
          const page = start + p, size = Math.min(pageBytes, bytes - page * pageBytes);
          read(fd, raw, size, rawHeader.length + page * pageBytes);
          for (let b = 0; b < size; b += 2) {
            const value = raw.readInt16LE(b);
            if (value > 0 && value < 256) raw.writeInt16LE(1, b);
          }
          const begin = offsets.readUInt32LE(p * 4), end = offsets.readUInt32LE((p + 1) * 4);
          assert.ok(end >= begin && end - begin <= pageBytes + 1024);
          let actual = zero.subarray(0, size);
          if (end > begin) {
            const compressed = Buffer.alloc(end - begin);
            read(packed, compressed, compressed.length, begin);
            actual = inflateRawSync(compressed, { maxOutputLength: size });
          }
          assert.ok(actual.equals(raw.subarray(0, size)), `Packed data mismatch at page ${page}`);
          checked++;
        }
      } finally { closeSync(packed); }
    }
    assert.equal(checked, pages);
    console.log(JSON.stringify({ packedPagesVerified: checked, denseSlotsVerified: bytes / 2 }));
  } finally { closeSync(fd); }
}

if (process.argv[1]?.endsWith('verify-full-tablebase.mjs')) {
  const [exe, file, directory] = process.argv.slice(2);
  if (exe === '--packed' && file && directory) verifyPacked(file, directory);
  else if (exe && exe !== '--packed' && !directory) verify(exe, file);
  else throw new Error('Usage: node train/verify-full-tablebase.mjs EXE [TABLE] OR --packed TABLE DIRECTORY');
}
