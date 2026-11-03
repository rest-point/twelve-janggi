import { loadConfig } from './config.mjs';
import { openDatabase } from './database.mjs';
import { createApplication } from './app.mjs';

let db, app;
try {
  const config = loadConfig();
  db = openDatabase(config.dbPath);
  app = createApplication(config, db);
  await app.ready;
  app.server.on('error', error => { console.error(`Server startup failed: ${error.code || 'unknown'}`); app.server.close(); db.close(); if (process.connected) process.disconnect(); process.exitCode = 1; });
  app.server.listen(config.port, config.host, () => console.log(`Guest arena ready: ${config.origin} (${config.profile}; HTTP 127.0.0.1:3000)`));
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true;
    app.server.close(() => { db.close(); if (process.connected) process.disconnect(); });
    app.server.closeIdleConnections();
    setTimeout(() => app.server.closeAllConnections(), 5000).unref();
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // A local parent process can request the same graceful shutdown on Windows,
  // where child.kill('SIGTERM') forcibly terminates rather than emitting SIGTERM.
  process.on('message', message => { if (message === 'shutdown') stop(); });
} catch (error) { db?.close(); if (process.connected) process.disconnect(); console.error(`Startup refused: ${error.message}`); process.exitCode = 1; }
