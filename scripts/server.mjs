import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExperimentStore, RecordError } from './experiment-store.mjs';
import { archiveRoute, serveAsset } from './lib/web-assets.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, process.argv.includes('--dist') ? 'dist' : '.');
const store = createExperimentStore(path.join(project, 'artifacts'));
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 5173);
const server=http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      const body = pathname === '/api/me' ? {guestMode:false} : await archiveRoute(pathname, store);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); return;
    }
    await serveAsset(req, res, root, pathname);
  } catch (error) {
    const status = error instanceof RecordError ? error.status : error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: error instanceof RecordError ? error.message : status === 404 ? 'Not found' : '기록을 읽을 수 없습니다.' }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`twelve-janggi ready at http://127.0.0.1:${server.address().port}`));
