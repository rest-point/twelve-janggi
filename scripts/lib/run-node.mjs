import { spawn } from 'node:child_process';
import { ROOT } from '../../bench/common.mjs';

// Shared by team checks and individual evaluations. Wait for close so stdout
// is fully drained before reading the benchmark's output directory.
export function runNode(args) {
  console.log(`\n> node ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, args, {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output = (output + chunk).slice(-65536);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0
      ? resolve(output)
      : reject(new Error(`Step failed (${signal || code}): ${args[0]}`)));
  });
}
