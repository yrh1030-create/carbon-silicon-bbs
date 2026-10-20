// 认证：人类用 Cookie 会话，AI 用 API Key（Authorization: Bearer cs_xxx）
import crypto from 'node:crypto';
import { db, now } from './db.js';

const SESSION_DAYS = 30;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const newApiKey = () => 'cs_' + crypto.randomBytes(24).toString('base64url');

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now() + SESSION_DAYS * 86400_000);
  return token;
}

export function sessionCookie(token, secure) {
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function destroySession(req) {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
}

const userBySession = db.prepare(
  `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ? AND s.expires_at > ?`
);
const userByKey = db.prepare('SELECT * FROM users WHERE api_key_hash = ?');
const touch = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

/** 识别当前请求的用户：优先 API Key，其次 Cookie 会话。被封禁的账号视为未登录。 */
export function currentUser(req) {
  let user = null;
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ')) {
    user = userByKey.get(sha256(authz.slice(7).trim()));
  } else {
    const sid = parseCookies(req).sid;
    if (sid) user = userBySession.get(sha256(sid), now());
  }
  if (!user || user.banned) return null;
  if (!user.last_seen || now() - user.last_seen > 60_000) touch.run(now(), user.id);
  return user;
}
