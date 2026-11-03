import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.mjs';
import { requestContext, checkTransport, checkOrigin, sessionCookie } from '../server/security.mjs';

const secret = randomBytes(32).toString('base64url');
// Unit cases must never read the developer's real .env.
const emptyRoot = path.join(os.tmpdir(), `twelve-no-config-${randomBytes(8).toString('hex')}`);
test('profiles load .env without overwriting it; process env wins and paths use root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'twelve-config-'));
  try {
    await writeFile(path.join(root, '.env'), `APP_PROFILE=laptop\nSESSION_SECRET=${secret}\nSQLITE_PATH=./data/laptop-dev.sqlite\n`);
    const laptop = loadConfig({ root, env:{} });
    assert.equal(laptop.dbPath, path.join(root, 'data/laptop-dev.sqlite'));
    assert.equal(laptop.origin, 'http://localhost:3000'); assert.equal(laptop.secure, false);
    const desktop = loadConfig({ root, env:{ APP_PROFILE:'desktop', APP_ORIGIN:'https://river-stone-forest.trycloudflare.com', SQLITE_PATH:'./data/twelve-janggi.sqlite' } });
    assert.equal(desktop.secure, true); assert.equal(desktop.trustProxy, true);
    assert.match(sessionCookie(desktop, 'token'), /^__Host-twelve-session=/);
    assert.match(sessionCookie(desktop, 'token'), /HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
    assert.doesNotMatch(sessionCookie(desktop, 'token'), /Domain=/i);
    assert.doesNotMatch(sessionCookie(laptop, 'token'), /; Secure/);
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive:true, force:true }); }
});
test('desktop refuses weak secrets, wildcard/placeholders, unsafe origins, cookie/proxy/bind overrides and mixed DBs', () => {
  const env = { APP_PROFILE:'desktop', APP_ORIGIN:'https://river-stone-forest.trycloudflare.com', SESSION_SECRET:secret };
  for (const origin of ['', 'https://*.trycloudflare.com', 'https://REPLACE_WITH_CURRENT_TUNNEL.trycloudflare.com', 'https://example.trycloudflare.com', 'http://river.trycloudflare.com', 'https://river.trycloudflare.com/', 'https://river.trycloudflare.com:443', 'https://river.trycloudflare.com:123', 'https://river.trycloudflare.com?x=1', 'https://user@river.trycloudflare.com', 'https://river.trycloudflare.com/#x', 'https://river.trycloudflare.com.evil.org', 'https://river.trycloudflare.com\n']) assert.throws(() => loadConfig({ root:emptyRoot, env:{ ...env, APP_ORIGIN:origin } }), /APP_ORIGIN/);
  for (const patch of [{ SESSION_SECRET:'REPLACE_WITH_RANDOM_DESKTOP_SECRET' }, { SESSION_SECRET:'a'.repeat(64) }, { API_HOST:'0.0.0.0' }, { API_PORT:'3443' }, { TRUST_PROXY:'true' }, { SESSION_COOKIE_SECURE:'false' }, { PUBLIC_ACCESS:'local' }, { SQLITE_PATH:'data/laptop-dev.sqlite' }, { INTERACTIVE_MOVE_MS:'0' }]) assert.throws(() => loadConfig({ root:emptyRoot, env:{ ...env, ...patch } }));
  assert.throws(() => loadConfig({ root:emptyRoot, env:{ SESSION_SECRET:secret, SQLITE_PATH:'data/twelve-janggi.sqlite' } }));
});
test('proxy headers require a real loopback peer; host and origin never derive from forwarded headers', () => {
  const config = loadConfig({ root:emptyRoot, env:{ APP_PROFILE:'desktop', APP_ORIGIN:'https://river-stone-forest.trycloudflare.com', SESSION_SECRET:secret } });
  const req = { headers:{ host:'river-stone-forest.trycloudflare.com', origin:config.origin, 'x-forwarded-proto':'https', 'x-forwarded-host':'evil.org', 'x-forwarded-for':'127.0.0.1' }, socket:{ remoteAddress:'203.0.113.7' } };
  assert.equal(requestContext(req, config).trustedProxy, false); assert.throws(() => checkTransport(req, config), /HTTPS/);
  req.socket.remoteAddress = '127.0.0.1'; assert.equal(checkTransport(req, config).protocol, 'https'); checkOrigin(req, config);
  req.headers.origin = 'https://other.trycloudflare.com'; assert.throws(() => checkOrigin(req, config), /Origin/);
  req.headers.origin = config.origin; req.headers.host = 'evil.org'; assert.throws(() => checkTransport(req, config), /Host/);
  req.headers.host = new URL(config.origin).host; req.headers['x-forwarded-proto'] = 'https,http'; assert.throws(() => checkTransport(req, config));
});
