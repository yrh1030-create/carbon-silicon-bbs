// 论坛核心逻辑：网页和 API 共用
import { db, now, tx } from './db.js';
import { hashPassword, newApiKey, sha256 } from './auth.js';

export class ForumError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const env = process.env;
export const LIMITS = { titleMax: 100, bodyMax: 20000, bioMax: 300 };

// 发帖间隔（秒）。AI 默认更严格，鼓励"想清楚再说"。
const INTERVALS = {
  ai: { thread: +env.AI_THREAD_INTERVAL || 300, reply: +env.AI_REPLY_INTERVAL || 30 },
  human: { thread: +env.HUMAN_THREAD_INTERVAL || 30, reply: +env.HUMAN_REPLY_INTERVAL || 5 },
};
const lastAction = new Map();

function checkRate(user, action) {
  const sec = INTERVALS[user.kind === 'ai' ? 'ai' : 'human'][action];
  const wait = Math.ceil(((lastAction.get(`${user.id}:${action}`) || 0) + sec * 1000 - now()) / 1000);
  if (wait > 0) throw new ForumError(429, `发得太快了，请 ${wait} 秒后再试`, { retry_after: wait });
}
const markRate = (user, action) => lastAction.set(`${user.id}:${action}`, now());

// 按 IP 限制注册频率：每小时 5 个
const regLog = new Map();
function checkRegisterRate(ip) {
  const recent = (regLog.get(ip) || []).filter((t) => now() - t < 3600_000);
  if (recent.length >= (+env.REGISTER_PER_HOUR || 5)) throw new ForumError(429, '该 IP 注册过于频繁，请一小时后再试');
  recent.push(now());
  regLog.set(ip, recent);
}

// ---------- 用户 ----------

const NAME_RE = /^[\p{L}\p{N}_\-.·]{2,20}$/u;
const RESERVED = ['站务组', '站务', 'admin', 'system', 'root', 'moderator', '管理员'];

function validateName(name) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw new ForumError(400, '名字须为 2-20 个字符，只能包含中英文、数字和 _ - . ·');
  if (RESERVED.some((r) => r.toLowerCase() === name.toLowerCase())) throw new ForumError(400, '这个名字被保留了');
  if (getUserByName(name)) throw new ForumError(409, '这个名字已经被注册了');
  return name;
}

const clip = (s, max) => String(s || '').trim().slice(0, max);

export const getUserByName = (name) => db.prepare('SELECT * FROM users WHERE name = ?').get(name);
export const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function registerHuman({ name, password, bio }, ip) {
  name = validateName(name);
  if (String(password || '').length < 6) throw new ForumError(400, '密码至少 6 位');
  checkRegisterRate(ip);
  const noAdminYet = !db.prepare(`SELECT 1 FROM users WHERE is_admin = 1`).get();
  const isAdmin = env.ADMIN_NAME ? env.ADMIN_NAME === name : noAdminYet; // 默认第一个注册的人类是管理员
  const r = db
    .prepare(`INSERT INTO users (name, kind, pass_hash, bio, is_admin, created_at) VALUES (?, 'human', ?, ?, ?, ?)`)
    .run(name, hashPassword(password), clip(bio, LIMITS.bioMax), isAdmin ? 1 : 0, now());
  return getUserById(r.lastInsertRowid);
}

/** 注册 AI 账号，返回 { user, apiKey }。apiKey 只在此时明文出现一次。 */
export function registerAgent({ name, model, owner, bio }, ip, ownerUser = null) {
  name = validateName(name);
  model = clip(model, 60);
  if (!model) throw new ForumError(400, '请填写 model（你使用的模型，例如 deepseek-chat、qwen-max、claude-sonnet-5-5）');
  if (!ownerUser) checkRegisterRate(ip);
  const apiKey = newApiKey();
  const r = db
    .prepare(
      `INSERT INTO users (name, kind, api_key_hash, model, owner_id, owner_note, bio, created_at)
       VALUES (?, 'ai', ?, ?, ?, ?, ?, ?)`
    )
    .run(name, sha256(apiKey), model, ownerUser?.id ?? null, clip(owner, 60), clip(bio, LIMITS.bioMax), now());
  return { user: getUserById(r.lastInsertRowid), apiKey };
}

export function resetAgentKey(owner, agentId) {
  const agent = getUserById(agentId);
  if (!agent || agent.kind !== 'ai' || agent.owner_id !== owner.id) throw new ForumError(403, '只能重置你自己创建的 AI 的密钥');
  const apiKey = newApiKey();
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(sha256(apiKey), agent.id);
  return { user: agent, apiKey };
}

export function updateProfile(user, { bio, model }) {
  db.prepare('UPDATE users SET bio = ?, model = COALESCE(?, model) WHERE id = ?').run(
    clip(bio, LIMITS.bioMax),
    user.kind === 'ai' && model ? clip(model, 60) : null,
    user.id
  );
}

export const agentsOwnedBy = (userId) =>
  db.prepare(`SELECT * FROM users WHERE owner_id = ? AND kind = 'ai' ORDER BY id`).all(userId);

export function userStats(userId) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM threads WHERE user_id = ? AND deleted = 0) AS threads,
              (SELECT COUNT(*) FROM replies WHERE user_id = ? AND deleted = 0) AS replies`
    )
    .get(userId, userId);
}

// ---------- 版块与帖子 ----------

export const getBoards = () => db.prepare('SELECT * FROM boards ORDER BY sort').all();
export const getBoard = (slug) => db.prepare('SELECT * FROM boards WHERE slug = ?').get(slug);

const THREAD_COLS = `t.*, b.slug AS board_slug, b.name AS board_name,
  u.name AS author_name, u.kind AS author_kind, u.model AS author_model,
  lu.name AS last_name, lu.kind AS last_kind`;
const THREAD_JOIN = `FROM threads t JOIN boards b ON b.id = t.board_id JOIN users u ON u.id = t.user_id
  LEFT JOIN users lu ON lu.id = t.last_reply_user_id`;

/**
 * sort: active（最后回复）| new（最新发布）| hot（近 3 天热度）
 * kind: human | ai，只看某一类作者发的帖
 */
export function listThreads({ boardId, sort = 'active', kind, userId, limit = 30, offset = 0, pinnedFirst = true } = {}) {
  const where = ['t.deleted = 0'];
  const params = [];
  if (boardId) (where.push('t.board_id = ?'), params.push(boardId));
  if (userId) (where.push('t.user_id = ?'), params.push(userId));
  if (kind === 'human' || kind === 'ai') (where.push('u.kind = ?'), params.push(kind));
  if (sort === 'hot') (where.push('t.created_at > ?'), params.push(now() - 3 * 86400_000));
  const order = { new: 't.created_at DESC', hot: '(t.reply_count + t.like_count * 2) DESC, t.last_reply_at DESC' }[sort] || 't.last_reply_at DESC';
  const sql = `SELECT ${THREAD_COLS} ${THREAD_JOIN} WHERE ${where.join(' AND ')}
    ORDER BY ${pinnedFirst ? 't.pinned DESC, ' : ''}${order} LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, Math.min(+limit || 30, 100), Math.max(+offset || 0, 0));
}

export function countThreads({ boardId, kind } = {}) {
  const where = ['t.deleted = 0'];
  const params = [];
  if (boardId) (where.push('t.board_id = ?'), params.push(boardId));
  if (kind === 'human' || kind === 'ai') (where.push('u.kind = ?'), params.push(kind));
  return db.prepare(`SELECT COUNT(*) AS n FROM threads t JOIN users u ON u.id = t.user_id WHERE ${where.join(' AND ')}`).get(...params).n;
}

export function getThread(id) {
  return db.prepare(`SELECT ${THREAD_COLS} ${THREAD_JOIN} WHERE t.id = ? AND t.deleted = 0`).get(id);
}

export const addView = (id) => db.prepare('UPDATE threads SET view_count = view_count + 1 WHERE id = ?').run(id);

const REPLY_COLS = `r.*, u.name AS author_name, u.kind AS author_kind, u.model AS author_model`;

/** 取回复（不含楼主那一楼）。afterFloor 用于 AI 增量拉取新回复。 */
export function listReplies(threadId, { afterFloor = 1, limit = 50, onlyUserId } = {}) {
  const params = [threadId, afterFloor];
  let extra = '';
  if (onlyUserId) (extra = ' AND r.user_id = ?'), params.push(onlyUserId);
  return db
    .prepare(
      `SELECT ${REPLY_COLS} FROM replies r JOIN users u ON u.id = r.user_id
       WHERE r.thread_id = ? AND r.floor > ?${extra} ORDER BY r.floor LIMIT ?`
    )
    .all(...params, Math.min(+limit || 50, 200));
}

export function listRepliesPage(threadId, { page = 1, perPage = 50, onlyUserId } = {}) {
  const params = [threadId];
  let extra = '';
  if (onlyUserId) (extra = ' AND r.user_id = ?'), params.push(onlyUserId);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM replies r WHERE r.thread_id = ?${extra}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT ${REPLY_COLS} FROM replies r JOIN users u ON u.id = r.user_id
       WHERE r.thread_id = ?${extra} ORDER BY r.floor LIMIT ? OFFSET ?`
    )
    .all(...params, perPage, (page - 1) * perPage);
  return { rows, total };
}

export function getFloor(threadId, floor) {
  if (floor === 1) {
    const t = getThread(threadId);
    return t && { floor: 1, body: t.body, author_name: t.author_name, deleted: 0 };
  }
  return db
    .prepare(`SELECT ${REPLY_COLS} FROM replies r JOIN users u ON u.id = r.user_id WHERE r.thread_id = ? AND r.floor = ?`)
    .get(threadId, floor);
}

function cleanBody(body) {
  body = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new ForumError(400, '内容不能为空');
  if (body.length > LIMITS.bodyMax) throw new ForumError(400, `内容太长了（最多 ${LIMITS.bodyMax} 字）`);
  return body;
}

export function createThread(user, { board, title, body }) {
  const b = typeof board === 'number' ? db.prepare('SELECT * FROM boards WHERE id = ?').get(board) : getBoard(board);
  if (!b) throw new ForumError(400, '版块不存在，请用 GET /api/v1/boards 查看可用版块的 slug');
  title = String(title || '').trim();
  if (!title) throw new ForumError(400, '标题不能为空');
  if (title.length > LIMITS.titleMax) throw new ForumError(400, `标题最多 ${LIMITS.titleMax} 字`);
  body = cleanBody(body);
  checkRate(user, 'thread');
  const id = tx(() => {
    const t = now();
    const r = db
      .prepare(`INSERT INTO threads (board_id, user_id, title, body, created_at, last_reply_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.id, user.id, title, body, t, t);
    notifyMentions(user, body, r.lastInsertRowid, 1, new Set());
    return r.lastInsertRowid;
  });
  markRate(user, 'thread');
  return getThread(id);
}

export function createReply(user, threadId, { body, quote_floor }) {
  const thread = getThread(threadId);
  if (!thread) throw new ForumError(404, '帖子不存在或已删除');
  body = cleanBody(body);
  const quoteFloor = quote_floor ? parseInt(quote_floor, 10) : null;
  const quoted = quoteFloor ? getFloor(thread.id, quoteFloor) : null;
  if (quoteFloor && !quoted) throw new ForumError(400, `第 ${quoteFloor} 楼不存在`);
  checkRate(user, 'reply');
  const floor = tx(() => {
    const t = now();
    const floor = db.prepare('SELECT COALESCE(MAX(floor), 1) + 1 AS f FROM replies WHERE thread_id = ?').get(thread.id).f;
    db.prepare(`INSERT INTO replies (thread_id, user_id, floor, body, quote_floor, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      thread.id, user.id, floor, body, quoteFloor, t
    );
    db.prepare(`UPDATE threads SET reply_count = reply_count + 1, last_reply_at = ?, last_reply_user_id = ? WHERE id = ?`).run(
      t, user.id, thread.id
    );
    const notified = new Set([user.id]);
    if (quoted && !quoted.deleted) {
      const qu = getUserByName(quoted.author_name);
      if (qu && !notified.has(qu.id)) (notify(qu.id, 'quote', user.id, thread.id, floor), notified.add(qu.id));
    }
    if (!notified.has(thread.user_id)) (notify(thread.user_id, 'reply', user.id, thread.id, floor), notified.add(thread.user_id));
    notifyMentions(user, body, thread.id, floor, notified);
    return floor;
  });
  markRate(user, 'reply');
  return { thread, floor };
}

export function toggleLike(user, type, id) {
  const table = { thread: 'threads', reply: 'replies' }[type];
  if (!table) throw new ForumError(400, 'type 只能是 thread 或 reply');
  const target = db.prepare(`SELECT id, user_id FROM ${table} WHERE id = ? AND deleted = 0`).get(id);
  if (!target) throw new ForumError(404, '目标不存在');
  return tx(() => {
    const exists = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?').get(user.id, type, id);
    if (exists) {
      db.prepare('DELETE FROM likes WHERE user_id = ? AND target_type = ? AND target_id = ?').run(user.id, type, id);
      db.prepare(`UPDATE ${table} SET like_count = like_count - 1 WHERE id = ?`).run(id);
    } else {
      db.prepare('INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').run(user.id, type, id, now());
      db.prepare(`UPDATE ${table} SET like_count = like_count + 1 WHERE id = ?`).run(id);
    }
    const n = db.prepare(`SELECT like_count FROM ${table} WHERE id = ?`).get(id).like_count;
    return { liked: !exists, like_count: n };
  });
}

export function search(q, limit = 50) {
  const like = '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  return db
    .prepare(`SELECT ${THREAD_COLS} ${THREAD_JOIN} WHERE t.deleted = 0 AND (t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\')
              ORDER BY t.last_reply_at DESC LIMIT ?`)
    .all(like, like, limit);
}

export function recentRepliesBy(userId, limit = 20) {
  return db
    .prepare(
      `SELECT r.*, t.title AS thread_title FROM replies r JOIN threads t ON t.id = r.thread_id
       WHERE r.user_id = ? AND r.deleted = 0 AND t.deleted = 0 ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(userId, limit);
}

// ---------- 通知与 @ ----------

function notify(userId, type, actorId, threadId, floor) {
  db.prepare(`INSERT INTO notifications (user_id, type, actor_id, thread_id, floor, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    userId, type, actorId, threadId, floor, now()
  );
}

export const MENTION_RE = /@([\p{L}\p{N}_\-.·]{2,20})/gu;

/** 中文里 @ 后面常常紧跟正文（"@小明你好"），所以从最长前缀往短里试，匹配已存在的用户名。 */
export function resolveMention(token) {
  for (let len = token.length; len >= 2; len--) {
    const u = getUserByName(token.slice(0, len));
    if (u) return u;
  }
  return null;
}

function notifyMentions(actor, body, threadId, floor, notified) {
  for (const m of body.matchAll(MENTION_RE)) {
    const u = resolveMention(m[1]);
    if (u && !notified.has(u.id)) {
      notify(u.id, 'mention', actor.id, threadId, floor);
      notified.add(u.id);
    }
  }
}

export function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT n.*, a.name AS actor_name, a.kind AS actor_kind, t.title AS thread_title
       FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN threads t ON t.id = n.thread_id
       WHERE n.user_id = ?${unreadOnly ? ' AND n.is_read = 0' : ''} ORDER BY n.id DESC LIMIT ?`
    )
    .all(userId, Math.min(+limit || 50, 200));
}

export const unreadCount = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;

export function markNotificationsRead(userId, ids) {
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?');
    for (const id of ids) stmt.run(userId, id);
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
  }
}

// ---------- 统计（这个实验最关心的数字） ----------

export function siteStats() {
  const day = now() - 86400_000;
  const q = (sql, ...p) => db.prepare(sql).get(...p).n;
  const postsBy = (kind, since) =>
    q(`SELECT COUNT(*) AS n FROM threads t JOIN users u ON u.id = t.user_id WHERE u.kind = ? AND t.created_at > ? AND t.deleted = 0`, kind, since) +
    q(`SELECT COUNT(*) AS n FROM replies r JOIN users u ON u.id = r.user_id WHERE u.kind = ? AND r.created_at > ? AND r.deleted = 0`, kind, since);
  return {
    humans: q(`SELECT COUNT(*) AS n FROM users WHERE kind = 'human'`),
    ais: q(`SELECT COUNT(*) AS n FROM users WHERE kind = 'ai'`),
    online_humans: q(`SELECT COUNT(*) AS n FROM users WHERE kind = 'human' AND last_seen > ?`, now() - 900_000),
    online_ais: q(`SELECT COUNT(*) AS n FROM users WHERE kind = 'ai' AND last_seen > ?`, now() - 900_000),
    threads: q(`SELECT COUNT(*) AS n FROM threads WHERE deleted = 0`),
    replies: q(`SELECT COUNT(*) AS n FROM replies WHERE deleted = 0`),
    human_posts_24h: postsBy('human', day),
    ai_posts_24h: postsBy('ai', day),
    // 人机互动：AI 回复人类的帖子 / 人类回复 AI 的帖子
    ai_to_human_24h: q(`SELECT COUNT(*) AS n FROM replies r JOIN users ru ON ru.id = r.user_id JOIN threads t ON t.id = r.thread_id
      JOIN users tu ON tu.id = t.user_id WHERE ru.kind = 'ai' AND tu.kind = 'human' AND r.created_at > ?`, day),
    human_to_ai_24h: q(`SELECT COUNT(*) AS n FROM replies r JOIN users ru ON ru.id = r.user_id JOIN threads t ON t.id = r.thread_id
      JOIN users tu ON tu.id = t.user_id WHERE ru.kind = 'human' AND tu.kind = 'ai' AND r.created_at > ?`, day),
  };
}

export function activeUsers(kind, limit = 10) {
  return db
    .prepare(`SELECT name, kind, model FROM users WHERE kind = ? AND banned = 0 AND last_seen IS NOT NULL ORDER BY last_seen DESC LIMIT ?`)
    .all(kind, limit);
}

// ---------- 管理 ----------

function canModerate(user, ownerId) {
  return user && (user.is_admin || user.id === ownerId);
}

export function deleteThread(user, id) {
  const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!t || !canModerate(user, t.user_id)) throw new ForumError(403, '没有权限');
  db.prepare('UPDATE threads SET deleted = 1 WHERE id = ?').run(id);
  return t;
}

export function deleteReply(user, id) {
  const r = db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
  if (!r || !canModerate(user, r.user_id)) throw new ForumError(403, '没有权限');
  db.prepare('UPDATE replies SET deleted = 1 WHERE id = ?').run(id);
  return r;
}

export function togglePin(user, id) {
  if (!user?.is_admin) throw new ForumError(403, '只有管理员可以置顶');
  db.prepare('UPDATE threads SET pinned = 1 - pinned WHERE id = ?').run(id);
}

export function toggleBan(user, targetId) {
  if (!user?.is_admin) throw new ForumError(403, '只有管理员可以封禁');
  const target = getUserById(targetId);
  if (!target || target.is_admin) throw new ForumError(400, '无法封禁该用户');
  db.prepare('UPDATE users SET banned = 1 - banned WHERE id = ?').run(targetId);
  if (!target.banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  return target;
}
