import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig({ root = ROOT, env = process.env } = {}) {
  let file = {};
  try { file = parseEnv(readFileSync(path.join(root, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const values = { ...file, ...env };
  const profile = values.APP_PROFILE || 'laptop';
  if (!['laptop', 'desktop'].includes(profile)) throw new Error('APP_PROFILE must be laptop or desktop');
  const desktop = profile === 'desktop';
  const expected = { API_HOST: '127.0.0.1', API_PORT: '3000', PUBLIC_ACCESS: desktop ? 'quick-tunnel' : 'local', SESSION_COOKIE_SECURE: String(desktop), TRUST_PROXY: desktop ? 'loopback' : 'none' };
  for (const [key, value] of Object.entries(expected)) if (values[key] !== undefined && values[key] !== value) throw new Error(`Invalid ${key} for ${profile}`);
  const origin = values.APP_ORIGIN || (desktop ? '' : 'http://localhost:3000');
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('Invalid APP_ORIGIN'); }
  if (origin !== parsed.origin || /replace|placeholder|example|임시|이번|<|>|\*/i.test(origin)) throw new Error('APP_ORIGIN must be one exact origin, without placeholders');
  if (desktop ? !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(origin) : !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) throw new Error('Invalid APP_ORIGIN for profile');
  const secret = values.SESSION_SECRET || '';
  if (secret.length < 43 || new Set(secret).size < 16 || /replace|placeholder|example/i.test(secret)) throw new Error('SESSION_SECRET: generate at least 32 random bytes (base64url)');
  const dbPath = path.resolve(root, values.SQLITE_PATH || (desktop ? 'data/twelve-janggi.sqlite' : 'data/laptop-dev.sqlite'));
  if (!/\.sqlite$/i.test(dbPath) || (desktop && path.basename(dbPath) === 'laptop-dev.sqlite') || (!desktop && path.basename(dbPath) === 'twelve-janggi.sqlite')) throw new Error('Use a separate .sqlite file for each profile');
  for (const [key, expectedValue] of [['INTERACTIVE_MOVE_MS', 60000], ['BATCH_CONCURRENCY', 2]]) {
    if (values[key] !== undefined && Number(values[key]) !== expectedValue) throw new Error(`M1 requires ${key}=${expectedValue}`);
  }
  // Preserve old .env files while migrating their former 1000ms default.
  if(values.MODEL_MOVE_MS!==undefined&&!['1000','60000'].includes(values.MODEL_MOVE_MS))throw new Error('MODEL_MOVE_MS must be 60000');
  return Object.freeze({ root, profile, origin, secret, dbPath, host: '127.0.0.1', port: 3000, secure: desktop, trustProxy: desktop, moveMs: 60000 });
}
