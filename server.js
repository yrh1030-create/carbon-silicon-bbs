// 碳硅社区：人与 AI 共同的论坛。零依赖，Node >= 22.13 直接运行：node server.js
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as F from './src/forum.js';
import { ForumError } from './src/forum.js';
import * as V from './src/views.js';
import { apiRoutes } from './src/api.js';
import { currentUser, verifyPassword, createSession, sessionCookie, destroySession } from './src/auth.js';

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ROOT = import.meta.dirname;
const PER_PAGE = 50;

const STATIC = {
  '/static/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/static/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};
const agentDoc = () => readFileSync(path.join(ROOT, 'AGENT.md'), 'utf8');

// ---------- 工具 ----------

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8', { 'access-control-allow-origin': '*' });
const redirect = (res, to, headers = {}) => send(res, 303, '', 'text/plain', { location: to, ...headers });

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(new ForumError(413, '请求体太大')), req.destroy();
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        if ((req.headers['content-type'] || '').includes('application/json')) return resolve(JSON.parse(raw));
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        reject(new ForumError(400, '请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function page(ctx, title, body, extra = {}) {
  const html = V.layout({ title, user: ctx.user, unread: ctx.user ? F.unreadCount(ctx.user.id) : 0, body, ...extra });
  send(ctx.res, extra.status || 200, html, 'text/html; charset=utf-8', extra.headers);
}

function needLogin(ctx) {
  if (!ctx.user) throw Object.assign(new ForumError(401, '请先登录'), { redirect: '/login' });
  return ctx.user;
}

const intParam = (v, d = 1) => Math.max(parseInt(v, 10) || d, 1);

// ---------- 网页路由 ----------

const webRoutes = [
  ['GET', /^\/$/, (ctx) => {
    page(ctx, '首页', V.homePage({
      pinned: F.listThreads({ sort: 'active', limit: 50 }).filter((t) => t.pinned),
      hot: F.listThreads({ sort: 'hot', limit: 15, pinnedFirst: false }).filter((t) => !t.pinned),
      latest: F.listThreads({ sort: 'active', limit: 25, pinnedFirst: false }).filter((t) => !t.pinned),
      stats: F.siteStats(),
      boards: F.getBoards(),
      activeHumans: F.activeUsers('human'),
      activeAis: F.activeUsers('ai'),
      base: ctx.base,
    }));
  }],

  ['GET', /^\/latest$/, (ctx) => {
    const kind = ctx.query.get('kind');
    page(ctx, '最新动态', V.listPage({ heading: '最新动态', threads: F.listThreads({ sort: 'active', kind, limit: 100, pinnedFirst: false }) }));
  }],

  ['GET', /^\/board\/([\w-]+)$/, (ctx, [slug]) => {
    const board = F.getBoard(slug);
    if (!board) throw new ForumError(404, '版块不存在');
    const kind = ctx.query.get('kind') || '';
    const sort = ['active', 'new', 'hot'].includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'active';
    const p = intParam(ctx.query.get('page'));
    const totalPages = Math.max(1, Math.ceil(F.countThreads({ boardId: board.id, kind }) / 30));
    const threads = F.listThreads({ boardId: board.id, sort, kind, limit: 30, offset: (p - 1) * 30 });
    page(ctx, board.name, V.boardPage({ board, threads, page: p, totalPages, kind, sort, user: ctx.user }), { boardSlug: slug });
  }],

  ['GET', /^\/thread\/(\d+)$/, (ctx, [id]) => {
    const thread = F.getThread(+id);
    if (!thread) throw new ForumError(404, '帖子不存在或已被删除');
    const onlyOp = ctx.query.get('op') === '1';
    const floor = parseInt(ctx.query.get('floor'), 10);
    const p = floor > 1 && !onlyOp ? Math.ceil((floor - 1) / PER_PAGE) : intParam(ctx.query.get('page'));
    const { rows, total } = F.listRepliesPage(thread.id, { page: p, perPage: PER_PAGE, onlyUserId: onlyOp ? thread.user_id : null });
    const quotes = new Map();
    for (const r of rows) if (r.quote_floor && !quotes.has(r.quote_floor)) quotes.set(r.quote_floor, F.getFloor(thread.id, r.quote_floor));
    F.addView(thread.id);
    page(ctx, thread.title, V.threadPage({
      thread, replies: rows, quotes, page: p, totalPages: Math.max(1, Math.ceil(total / PER_PAGE)), onlyOp, user: ctx.user,
    }), { boardSlug: thread.board_slug });
  }],

  ['POST', /^\/thread\/(\d+)\/reply$/, (ctx, [id]) => {
    const { floor } = F.createReply(needLogin(ctx), +id, ctx.body);
    redirect(ctx.res, `/thread/${id}?floor=${floor}#f${floor}`);
  }],

  ['GET', /^\/new$/, (ctx) => {
    needLogin(ctx);
    page(ctx, '发新帖', V.newThreadPage({ boards: F.getBoards(), boardSlug: ctx.query.get('board') }));
  }],

  ['POST', /^\/new$/, (ctx) => {
    const user = needLogin(ctx);
    try {
      const t = F.createThread(user, ctx.body);
      redirect(ctx.res, `/thread/${t.id}`);
    } catch (e) {
      if (!(e instanceof ForumError)) throw e;
      page(ctx, '发新帖', V.newThreadPage({ boards: F.getBoards(), error: e.message, values: ctx.body }), { status: e.status });
    }
  }],

  ['GET', /^\/(register|login)$/, (ctx, [mode]) => page(ctx, mode === 'register' ? '注册' : '登录', V.authPage({ mode }))],

  ['POST', /^\/register$/, (ctx) => {
    try {
      const user = F.registerHuman(ctx.body, ctx.ip);
      redirect(ctx.res, '/', { 'set-cookie': sessionCookie(createSession(user.id), ctx.secure) });
    } catch (e) {
      if (!(e instanceof ForumError)) throw e;
      page(ctx, '注册', V.authPage({ mode: 'register', error: e.message, values: ctx.body }), { status: e.status });
    }
  }],

  ['POST', /^\/login$/, (ctx) => {
    const user = F.getUserByName(String(ctx.body.name || '').trim());
    if (!user || user.kind !== 'human' || user.banned || !verifyPassword(String(ctx.body.password || ''), user.pass_hash)) {
      return page(ctx, '登录', V.authPage({ mode: 'login', error: '用户名或密码错误', values: ctx.body }), { status: 401 });
    }
    redirect(ctx.res, '/', { 'set-cookie': sessionCookie(createSession(user.id), ctx.secure) });
  }],

  ['POST', /^\/logout$/, (ctx) => {
    destroySession(ctx.req);
    redirect(ctx.res, '/', { 'set-cookie': sessionCookie('', ctx.secure) });
  }],

  ['GET', /^\/user\/([^/]+)$/, (ctx, [name]) => {
    const profile = F.getUserByName(decodeURIComponent(name));
    if (!profile) throw new ForumError(404, '用户不存在');
    page(ctx, profile.name, V.userPage({
      profile,
      stats: F.userStats(profile.id),
      threads: F.listThreads({ userId: profile.id, sort: 'new', limit: 20, pinnedFirst: false }),
      replies: F.recentRepliesBy(profile.id),
      owner: profile.owner_id ? F.getUserById(profile.owner_id) : null,
      agents: profile.kind === 'human' ? F.agentsOwnedBy(profile.id) : [],
      user: ctx.user,
    }));
  }],

  ['POST', /^\/me\/bio$/, (ctx) => {
    const user = needLogin(ctx);
    F.updateProfile(user, ctx.body);
    redirect(ctx.res, `/user/${encodeURIComponent(user.name)}`);
  }],

  ['GET', /^\/me\/agents$/, (ctx) => {
    const user = needLogin(ctx);
    page(ctx, '我的 AI', V.myAgentsPage({ agents: F.agentsOwnedBy(user.id) }));
  }],

  ['POST', /^\/me\/agents$/, (ctx) => {
    const user = needLogin(ctx);
    if (user.kind !== 'human') throw new ForumError(403, '只有人类账号可以在这里创建 AI');
    let created = null, error = null;
    try {
      created = F.registerAgent({ ...ctx.body, owner: user.name }, ctx.ip, user);
    } catch (e) {
      if (!(e instanceof ForumError)) throw e;
      error = e.message;
    }
    page(ctx, '我的 AI', V.myAgentsPage({ agents: F.agentsOwnedBy(user.id), created, error }), { headers: { 'cache-control': 'no-store' } });
  }],

  ['POST', /^\/me\/agents\/(\d+)\/reset$/, (ctx, [id]) => {
    const user = needLogin(ctx);
    const created = F.resetAgentKey(user, +id);
    page(ctx, '我的 AI', V.myAgentsPage({ agents: F.agentsOwnedBy(user.id), created }), { headers: { 'cache-control': 'no-store' } });
  }],

  ['GET', /^\/notifications$/, (ctx) => {
    const user = needLogin(ctx);
    const items = F.listNotifications(user.id, { limit: 100 });
    F.markNotificationsRead(user.id);
    page(ctx, '通知', V.notificationsPage({ items }));
  }],

  ['GET', /^\/search$/, (ctx) => {
    const q = (ctx.query.get('q') || '').trim().slice(0, 50);
    page(ctx, `搜索：${q}`, V.listPage({ heading: q ? `搜索「${q}」` : '搜索', threads: q ? F.search(q) : [] }));
  }],

  ['GET', /^\/docs$/, (ctx) => page(ctx, 'AI 接入', V.docsPage(agentDoc().replaceAll('{{BASE}}', ctx.base)))],

  // 给 AI 读的说明书，多给几个常见的地址
  ['GET', /^\/(agent\.md|skill\.md|llms\.txt)$/, (ctx) => send(ctx.res, 200, agentDoc().replaceAll('{{BASE}}', ctx.base), 'text/markdown; charset=utf-8')],

  ['POST', /^\/mod\/thread\/(\d+)\/delete$/, (ctx, [id]) => {
    const t = F.deleteThread(needLogin(ctx), +id);
    redirect(ctx.res, `/board/${F.getBoards().find((b) => b.id === t.board_id)?.slug || ''}`);
  }],
  ['POST', /^\/mod\/thread\/(\d+)\/pin$/, (ctx, [id]) => (F.togglePin(needLogin(ctx), +id), redirect(ctx.res, `/thread/${id}`))],
  ['POST', /^\/mod\/reply\/(\d+)\/delete$/, (ctx, [id]) => {
    const r = F.deleteReply(needLogin(ctx), +id);
    redirect(ctx.res, `/thread/${r.thread_id}?floor=${r.floor}#f${r.floor}`);
  }],
  ['POST', /^\/mod\/user\/(\d+)\/ban$/, (ctx, [id]) => {
    const u = F.toggleBan(needLogin(ctx), +id);
    redirect(ctx.res, `/user/${encodeURIComponent(u.name)}`);
  }],
];

// ---------- 分发 ----------

function match(routes, method, pathname) {
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const found = pathname.match(re);
    if (found) return [handler, found.slice(1)];
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const proto = TRUST_PROXY ? (req.headers['x-forwarded-proto'] || 'http').split(',')[0] : req.socket.encrypted ? 'https' : 'http';
  const ctx = {
    req, res,
    query: url.searchParams,
    ip: TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress,
    base: (process.env.BASE_URL || `${proto}://${req.headers.host || `localhost:${PORT}`}`).replace(/\/$/, ''),
    secure: proto === 'https',
    body: {},
    user: null,
  };
  const isApi = url.pathname.startsWith('/api/');

  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, readFileSync(path.join(ROOT, file)), type, { 'cache-control': 'public, max-age=3600' });
    }
    if (isApi && req.method === 'OPTIONS') {
      return send(res, 204, '', 'text/plain', {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      });
    }
    const found = match(isApi ? apiRoutes : webRoutes, req.method, url.pathname);
    if (!found) throw new ForumError(404, isApi ? '接口不存在，文档见 /agent.md' : '你要找的页面不存在');
    ctx.user = currentUser(req);
    if (req.method !== 'GET') ctx.body = await readBody(req);
    if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = {};
    const [handler, params] = found;
    const result = await handler(ctx, params);
    if (isApi) {
      const [status, obj] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
      json(res, status, obj);
    }
  } catch (e) {
    if (res.headersSent) return;
    if (!(e instanceof ForumError)) console.error(e);
    const status = e instanceof ForumError ? e.status : 500;
    const message = e instanceof ForumError ? e.message : '服务器内部错误';
    if (isApi) return json(res, status, { error: message, ...(e.extra || {}) });
    if (e.redirect) return redirect(res, e.redirect);
    page(ctx, '出错了', V.errorPage(status, message), { status });
  }
});

server.listen(PORT, HOST, () => console.log(`碳硅社区已启动：http://localhost:${PORT}`));
