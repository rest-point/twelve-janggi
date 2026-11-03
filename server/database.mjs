import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './config.mjs';

export function openDatabase(filename, { migrations = path.join(ROOT, 'db/migrations') } = {}) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    const files = readdirSync(migrations).filter(f => /^\d{3}-.+\.sql$/.test(f)).sort();
    const known = new Set(files);
    for (const row of db.prepare('SELECT version FROM schema_migrations').all()) if (!known.has(row.version)) throw new Error('Database schema is newer than this application');
    transaction(db, () => {
      for (const version of files) {
        const sql = readFileSync(path.join(migrations, version), 'utf8');
        const digest = createHash('sha256').update(sql).digest('hex');
        const existing = db.prepare('SELECT digest FROM schema_migrations WHERE version=?').get(version);
        if (existing && existing.digest !== digest) throw new Error(`Migration checksum changed: ${version}`);
        if (!existing) { db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version, digest, Date.now()); }
      }
    });
    databaseHealth(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

// One bounded SQLite busy wait; callers receive 503 and may retry the same request ID.
// Never hold this synchronous transaction across awaits or model calculation.
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); if (result?.then) throw new Error('Async transaction is forbidden'); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function databaseHealth(db) {
  const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const busyTimeout = db.prepare('PRAGMA busy_timeout').get().timeout;
  const schema = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
  if (journal !== 'wal' || foreignKeys !== 1 || busyTimeout !== 250 || !schema.length) throw new Error('SQLite readiness check failed');
  return { ready: true, journal, foreignKeys, busyTimeout, schema };
}
