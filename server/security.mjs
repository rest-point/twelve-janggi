import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireThat(condition, status, message) { if (!condition) throw new HttpError(status, message); }
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (secret, label, value) => createHmac('sha256', secret).update(`${label}:${value}`).digest('hex');
export function isLoopback(address) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address); }
export function requestContext(req, config) {
  const trusted = config.trustProxy && isLoopback(req.socket.remoteAddress);
  // Forwarded headers are metadata only; origin/host are never inferred from them.
  const protocol = trusted && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return { trustedProxy: trusted, protocol, clientKey: req.socket.remoteAddress || 'unknown' };
}
export function checkOrigin(req, config) {
  requireThat(req.headers.origin === config.origin, 403, '허용하지 않는 Origin입니다.');
  requireThat(req.headers['sec-fetch-site'] !== 'cross-site', 403, '교차 사이트 요청을 거부했습니다.');
}
export function checkTransport(req, config) {
  const context = requestContext(req, config);
  requireThat(req.headers.host === new URL(config.origin).host, 403, '허용하지 않는 Host입니다.');
  if (config.secure) requireThat(context.trustedProxy && context.protocol === 'https', 403, 'HTTPS 프록시 연결이 필요합니다.');
  return context;
}
export function cookieName(config) { return config.secure ? '__Host-twelve-session' : 'twelve-session'; }
export function sessionCookie(config, token, maxAge = 604800) {
  return `${cookieName(config)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
}
export function readToken(req, config) {
  const prefix = `${cookieName(config)}=`;
  const values = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(prefix));
  const token = values.length === 1 ? values[0].slice(prefix.length) : '';
  return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : '';
}
