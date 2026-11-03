import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../bench/common.mjs';
import { runNode } from './lib/run-node.mjs';

export async function evaluate(args = []) {
  const output = await runNode(['bench/run.mjs', ...args]);
  const directory = output.match(/^Output: (.+)$/m)?.[1].trim();
  if (!directory || !path.resolve(directory).startsWith(path.join(ROOT, 'artifacts') + path.sep)) throw new Error('Invalid run directory');
  await runNode(['scripts/verify-replays.mjs', '--run', directory]);
  console.log(`Verified report: ${path.join(directory, 'report.txt')}\nWeb (npm run dev): http://127.0.0.1:5173/experiments?run=${encodeURIComponent(path.basename(directory))}`);
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await evaluate(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
