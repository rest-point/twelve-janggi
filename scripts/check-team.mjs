import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../bench/common.mjs';
import { runNode } from './lib/run-node.mjs';
import { evaluate } from './evaluate.mjs';

try {
  const tests = (await readdir(path.join(ROOT, 'tests'))).filter(name => name.endsWith('.test.js')).sort().map(name => `tests/${name}`);
  if (!tests.length) throw new Error('No test files found');
  await runNode(['--test', ...tests]);
  await runNode(['scripts/build.mjs']);
  await evaluate(['--a', 'greedy-v1', '--b', 'random-v1', '--games', '100', '--concurrency', '2', '--seed', '20261031', '--opening-plies', '0', '--move-ms', '60000', '--max-plies', '256']);
  console.log('\nTeam checks passed. Setup, model protocol, rules and current capabilities: README.md');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
