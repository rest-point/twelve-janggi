import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RecordError } from '../experiment-store.mjs';

const files = ['index.html', 'experiments.html', 'analysis.html', 'records.html', 'favicon.svg',
  ...['app.js', 'online.js', 'engine.js', 'board-view.js', 'record-replay.js', 'replay-view.js', 'experiments.js', 'records.js', 'live.js', 'style.css', 'experiments.css', 'site-header.css', 'online.css', 'records.css', 'analysis.js', 'analysis-state.js', 'analysis.css'].map(f => 'src/' + f)];
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
export async function archiveRoute(pathname, store) {
  const parts = pathname.split('/').filter(Boolean);
  if (pathname === '/api/experiments') return { experiments: await store.list() };
  if (parts.length === 3 && parts[1] === 'experiments') return store.detail(parts[2]);
  if (parts.length === 5 && parts[1] === 'experiments' && parts[3] === 'games' && /^\d+$/.test(parts[4])) return store.game(parts[2], Number(parts[4]));
  throw new RecordError('API를 찾을 수 없습니다.', 404);
}
export async function serveAsset(req, res, root, pathname, { arena = false } = {}) {
  const asset = (arena && ['/arena', '/arena.html'].includes(pathname)) ? '/index.html'
    : ['/', '/twelve-janggi', '/index.html'].includes(pathname) ? '/index.html'
    : ['/experiments', '/experiments/', '/experiments.html'].includes(pathname) ? '/experiments.html'
    : ['/analysis','/analysis/','/analysis.html'].includes(pathname) ? '/analysis.html'
    : ['/records','/records/','/records.html'].includes(pathname) ? '/records.html' : pathname;
  if (!files.includes(asset.slice(1))) { res.writeHead(404).end('Not found'); return; }
  const file = await realpath(path.resolve(root, '.' + asset));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : await readFile(file));
}
