// Add 2-ply trap features to league rows: writes <rows>.trap.bin (N x TRAP float32).
// Usage: node train/tbrl-augment.mjs data/r0.bin [data/r1.bin ...]
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { FEATURES, TRAP, openTable, trapFeatures, positionFromFeatures } from '../models/tbrl-core.mjs';

const COLUMNS = FEATURES + 4;
const table = openTable(8192);
for (const file of process.argv.slice(2)) {
  const target = file + '.trap.bin';
  if (existsSync(target) && statSync(target).mtimeMs >= statSync(file).mtimeMs) { console.log(`${target} up to date`); continue; }
  const bytes = readFileSync(file);
  const rows = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const n = rows.length / COLUMNS, out = new Float32Array(n * TRAP);
  const started = performance.now();
  for (let i = 0; i < n; i++) {
    const row = rows.subarray(i * COLUMNS, i * COLUMNS + FEATURES);
    out.set(trapFeatures(positionFromFeatures(row), table), i * TRAP);
  }
  writeFileSync(target, Buffer.from(out.buffer));
  console.log(`${target}: ${n} rows in ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
