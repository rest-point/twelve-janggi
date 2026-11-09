export const MAGIC = 'TJS2TB01';
export const KEY_SIZE = 19;
export const RECORD_SIZE = 24;
export const NO_MOVE = 255;

export function loadTablebase(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.toString('ascii', 0, MAGIC.length) !== MAGIC || data.length <= MAGIC.length
    || (data.length - MAGIC.length) % RECORD_SIZE) throw new Error('Invalid strict-v2 tablebase');
  const table = new Map();
  for (let offset = MAGIC.length; offset < data.length; offset += RECORD_SIZE) {
    const key = data.toString('latin1', offset, offset + KEY_SIZE);
    const rank = data.readInt32LE(offset + KEY_SIZE), move = data[offset + KEY_SIZE + 4];
    if (!rank || (move >= 180 && move !== NO_MOVE) || table.has(key)) throw new Error('Invalid tablebase record');
    table.set(key, { value: Math.sign(rank), distance: Math.abs(rank) - 1, move });
  }
  return table;
}

export function probeTablebase(table, position) {
  const rootKey = position.key(), entry = table.get(rootKey);
  if (!entry || position.counts.get(rootKey) >= 3) return null;
  // Proof ranks decrease strictly. Only an earlier repeated position with a
  // smaller rank can reappear in the stored proof and invalidate the result.
  for (const [key, count] of position.counts) {
    if (count < 2) continue;
    const earlier = table.get(key);
    if (earlier && earlier.distance < entry.distance) return null;
  }
  return entry;
}
