import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { ROOT } from '../bench/common.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A local launcher that can request the production entry point's graceful IPC
// shutdown on Windows. Type `shutdown` on stdin after the current batch ends.
const directory = path.join(ROOT, 'data'), manifest = path.join(directory, 'winrate-server.json'), control = path.join(directory, 'winrate-server-stop.json');
await mkdir(directory, { recursive: true });
if (process.argv[2] === 'stop') {
  const running = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(control, JSON.stringify({ token: running.token, requestedAt: new Date().toISOString() }));
  console.log('Requested graceful server shutdown');
  process.exit(0);
}
const token = randomUUID();
const child = fork(new URL('../server/start.mjs', import.meta.url), [], {
  cwd: ROOT, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
await writeFile(manifest, JSON.stringify({ token, pid: child.pid, startedAt: new Date().toISOString() }));
let stopping = false;
function stop() {
  if (!stopping && child.connected) { stopping = true; child.send('shutdown'); }
}
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line.trim() === 'shutdown') stop(); });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const timer = setInterval(async () => {
  try { if (JSON.parse(await readFile(control, 'utf8')).token === token) stop(); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Could not read lab shutdown request:', error.message); }
}, 500);
timer.unref();
const [code, signal] = await once(child, 'exit');
clearInterval(timer);
input.close();
process.stdin.pause();
process.exitCode = code ?? (signal ? 1 : 0);
