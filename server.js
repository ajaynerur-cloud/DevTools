/* DevHub server — serves the web app and a small JSON API with user accounts.
 * No npm dependencies: Node 22+ only.
 *
 * Storage layout (in your GitHub data repo, or ./storage when running locally):
 *   <DATA_DIR>/users/index.json            accounts (scrypt password hashes, never plain text)
 *   <DATA_DIR>/users/<userId>/tasks.json   that user's tasks, projects and settings
 *   <DATA_DIR>/users/<userId>/links.json   that user's tool store links
 *   <DATA_DIR>/users/<userId>/prefs.json   that user's preferences
 * The user id always comes from the signed session token, so a user can only ever read or write their own files.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const env = process.env;
const cfg = {
  port: +env.PORT || 3000,
  ghToken: env.GITHUB_TOKEN || '',
  ghRepo: env.DATA_REPO || '',                       // "owner/repo" — use a PRIVATE repo
  ghBranch: env.DATA_BRANCH || 'main',
  ghApi: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
  dataDir: (env.DATA_DIR || 'devhub').replace(/^\/+|\/+$/g, ''),
  storageDir: env.STORAGE_DIR || path.join(__dirname, 'storage'),
  secret: env.SESSION_SECRET || '',
  sessionDays: +env.SESSION_DAYS || 30,
  registration: (env.REGISTRATION || 'open').toLowerCase(),   // open | code | closed
  regCode: env.REGISTRATION_CODE || '',
  cors: (env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  maxBody: 8 * 1024 * 1024
};
if (!cfg.secret) {
  cfg.secret = crypto.randomBytes(32).toString('hex');
  console.warn('[devhub] SESSION_SECRET is not set — everyone is signed out whenever the server restarts.');
}
if (cfg.registration === 'code' && !cfg.regCode) { console.warn('[devhub] REGISTRATION=code but REGISTRATION_CODE is empty — registration is closed.'); cfg.registration = 'closed'; }

/* ---------------- storage ---------------- */
function localStore() {
  const file = p => path.join(cfg.storageDir, cfg.dataDir, p);
  return {
    kind: 'local',
    async read(p) { try { return JSON.parse(await fsp.readFile(file(p), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async write(p, doc) {
      const f = file(p); await fsp.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n'); await fsp.rename(tmp, f);
    },
    async remove(p) { await fsp.rm(file(p), { force: true }); }
  };
}

function githubStore() {
  const cache = new Map(); // path -> { doc, sha }
  const url = p => `${cfg.ghApi}/repos/${cfg.ghRepo}/contents/${cfg.dataDir}/${p}`;
  const headers = { Authorization: `Bearer ${cfg.ghToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devhub-server' };
  async function fetchFile(p) {
    const r = await fetch(`${url(p)}?ref=${encodeURIComponent(cfg.ghBranch)}`, { headers });
    if (r.status === 404) return { doc: null, sha: null };
    if (!r.ok) throw new Error(`GitHub read ${p} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    let text;
    if (j.encoding === 'base64' && j.content) text = Buffer.from(j.content, 'base64').toString('utf8');
    else { // files over 1 MB come back without content; fetch the raw bytes
      const raw = await fetch(`${url(p)}?ref=${encodeURIComponent(cfg.ghBranch)}`, { headers: { ...headers, Accept: 'application/vnd.github.raw' } });
      if (!raw.ok) throw new Error(`GitHub raw read ${p} failed: ${raw.status}`);
      text = await raw.text();
    }
    return { doc: JSON.parse(text), sha: j.sha };
  }
  async function put(p, doc, sha, msg) {
    return fetch(url(p), {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, content: Buffer.from(JSON.stringify(doc, null, 2) + '\n').toString('base64'), branch: cfg.ghBranch, ...(sha ? { sha } : {}) })
    });
  }
  return {
    kind: 'github',
    async read(p) { if (!cache.has(p)) cache.set(p, await fetchFile(p)); return cache.get(p).doc; },
    async write(p, doc, msg = `devhub: update ${p}`) {
      if (!cache.has(p)) cache.set(p, await fetchFile(p));
      let r = await put(p, doc, cache.get(p).sha, msg);
      if (r.status === 409 || r.status === 422) { const f = await fetchFile(p); r = await put(p, doc, f.sha, msg); }
      if (!r.ok) throw new Error(`GitHub write ${p} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      cache.set(p, { doc, sha: (await r.json()).content.sha });
    },
    async remove(p, msg = `devhub: delete ${p}`) {
      const f = cache.get(p) || await fetchFile(p);
      if (f.sha) {
        const r = await fetch(url(p), { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, sha: f.sha, branch: cfg.ghBranch }) });
        if (!r.ok && r.status !== 404) throw new Error(`GitHub delete ${p} failed: ${r.status}`);
      }
      cache.delete(p);
    }
  };
}
const store = cfg.ghToken && cfg.ghRepo ? githubStore() : localStore();

// Serialise writes per file so concurrent requests never clobber each other.
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

/* ---------------- accounts ---------------- */
const USERS = 'users/index.json';
async function readUsers() { return (await store.read(USERS)) || { version: 1, users: {} }; }
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, email: u.email || '', createdAt: u.createdAt });
const findUser = (db, login) => { const l = String(login || '').trim().toLowerCase(); return Object.values(db.users).find(u => u.username.toLowerCase() === l || (u.email && u.email.toLowerCase() === l)); };

const scryptP = (pw, salt, n) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); const n = 16384; return `scrypt$${n}$${salt.toString('base64')}$${(await scryptP(pw, salt, n)).toString('base64')}`; }
async function verifyPassword(pw, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const k = await scryptP(pw, Buffer.from(salt, 'base64'), +n), h = Buffer.from(hash, 'base64');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/* ---------------- sessions (signed, stateless; revoked by bumping tokenVersion) ---------------- */
const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', cfg.secret).update(s).digest('base64url');
function issueToken(u) { const body = b64u(JSON.stringify({ uid: u.id, v: u.tokenVersion || 0, exp: Date.now() + cfg.sessionDays * 864e5 })); return `${body}.${sign(body)}`; }
async function authUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const good = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.exp || p.exp < Date.now()) return null;
  const u = (await readUsers()).users[p.uid];
  return u && (u.tokenVersion || 0) === p.v ? u : null;
}

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* ---------------- http helpers ---------------- */
function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > cfg.maxBody) { reject(Object.assign(new Error('Request is too large.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!size) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Request body must be JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function corsHeaders(req) {
  const o = (req.headers.origin || '').replace(/\/$/, '');
  if (!o) return {};
  const native = ['https://localhost', 'capacitor://localhost', 'http://localhost'].includes(o);
  if (native || cfg.cors.includes('*') || cfg.cors.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))
    return { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' };
  return {};
}

/* ---------------- API ---------------- */
const DOCS = new Set(['tasks', 'links', 'prefs']);
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function api(req, res, url) {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const reply = (s, o) => send(res, s, o, cors);
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (route === 'GET /api/health') return reply(200, { ok: true });
  if (route === 'GET /api/config') return reply(200, { registration: cfg.registration, storage: store.kind });

  if (route === 'POST /api/auth/register') {
    if (cfg.registration === 'closed') return reply(403, { error: 'Registration is closed. Ask the administrator for an account.' });
    if (limited('reg:' + ip, 10, 3600e3)) return reply(429, { error: 'Too many sign-ups from this network. Try again in an hour.' });
    const b = await readBody(req);
    const username = String(b.username || '').trim(), name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().slice(0, 120), password = String(b.password || '');
    const errors = {};
    if (!USERNAME.test(username)) errors.username = 'Use 3–32 letters, numbers, dots, dashes or underscores.';
    if (!name) errors.name = 'Enter your name.';
    if (email && !EMAIL.test(email)) errors.email = 'Enter a valid email address, or leave it blank.';
    if (password.length < 8) errors.password = 'Use at least 8 characters.';
    if (cfg.registration === 'code') { const a = Buffer.from(String(b.code || '')), c = Buffer.from(cfg.regCode); if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) errors.code = 'That invite code is not valid.'; }
    if (Object.keys(errors).length) return reply(400, { error: 'Check the highlighted fields.', fields: errors });
    const hash = await hashPassword(password);
    const result = await withLock(USERS, async () => {
      const db = await readUsers();
      if (findUser(db, username)) return { status: 409, body: { error: 'That username is taken.', fields: { username: 'That username is taken.' } } };
      if (email && findUser(db, email)) return { status: 409, body: { error: 'An account with that email already exists.', fields: { email: 'An account with that email already exists.' } } };
      const u = { id: crypto.randomUUID(), username, name, email, hash, tokenVersion: 0, createdAt: new Date().toISOString() };
      db.users[u.id] = u;
      await store.write(USERS, db, `devhub: register ${u.id}`);
      return { status: 201, body: { token: issueToken(u), user: publicUser(u) } };
    });
    return reply(result.status, result.body);
  }

  if (route === 'POST /api/auth/login') {
    const b = await readBody(req);
    const login = String(b.login || '').trim().toLowerCase();
    if (limited('login:' + ip, 30, 900e3) || limited('login:' + ip + ':' + login, 8, 900e3)) return reply(429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    const u = findUser(await readUsers(), login);
    const ok = await verifyPassword(String(b.password || ''), u ? u.hash : DUMMY_HASH); // same work whether or not the user exists
    if (!u || !ok) return reply(401, { error: 'Username or password is incorrect.' });
    return reply(200, { token: issueToken(u), user: publicUser(u) });
  }

  // Everything below needs a signed-in user
  const user = await authUser(req);
  if (!user) return reply(401, { error: 'Your session has ended. Sign in again.' });

  if (route === 'GET /api/auth/me') return reply(200, { user: publicUser(user) });

  if (route === 'POST /api/auth/profile') {
    const b = await readBody(req);
    const name = String(b.name ?? user.name).trim().slice(0, 80), email = String(b.email ?? user.email ?? '').trim().slice(0, 120);
    if (!name) return reply(400, { error: 'Enter your name.', fields: { name: 'Enter your name.' } });
    if (email && !EMAIL.test(email)) return reply(400, { error: 'Enter a valid email address.', fields: { email: 'Enter a valid email address.' } });
    const r = await withLock(USERS, async () => {
      const db = await readUsers(), u = db.users[user.id];
      if (email && Object.values(db.users).some(x => x.id !== u.id && x.email && x.email.toLowerCase() === email.toLowerCase())) return { s: 409, b: { error: 'Another account uses that email.', fields: { email: 'Another account uses that email.' } } };
      u.name = name; u.email = email; await store.write(USERS, db, `devhub: profile ${u.id}`);
      return { s: 200, b: { user: publicUser(u) } };
    });
    return reply(r.s, r.b);
  }

  if (route === 'POST /api/auth/password') {
    const b = await readBody(req);
    if (limited('pw:' + user.id, 10, 900e3)) return reply(429, { error: 'Too many attempts. Try again later.' });
    if (!(await verifyPassword(String(b.current || ''), user.hash))) return reply(400, { error: 'Your current password is incorrect.', fields: { current: 'Incorrect password.' } });
    if (String(b.next || '').length < 8) return reply(400, { error: 'Use at least 8 characters.', fields: { next: 'Use at least 8 characters.' } });
    const hash = await hashPassword(String(b.next));
    const u = await withLock(USERS, async () => { const db = await readUsers(), x = db.users[user.id]; x.hash = hash; x.tokenVersion = (x.tokenVersion || 0) + 1; await store.write(USERS, db, `devhub: password ${x.id}`); return x; });
    return reply(200, { token: issueToken(u), user: publicUser(u) }); // other devices are signed out
  }

  if (route === 'POST /api/auth/logout-all') {
    await withLock(USERS, async () => { const db = await readUsers(); db.users[user.id].tokenVersion = (db.users[user.id].tokenVersion || 0) + 1; await store.write(USERS, db, `devhub: sign out ${user.id}`); });
    return reply(200, { ok: true });
  }

  if (route === 'DELETE /api/auth/account') {
    const b = await readBody(req);
    if (!(await verifyPassword(String(b.password || ''), user.hash))) return reply(400, { error: 'Password is incorrect.', fields: { password: 'Incorrect password.' } });
    for (const d of DOCS) await withLock(`users/${user.id}/${d}.json`, () => store.remove(`users/${user.id}/${d}.json`));
    await withLock(USERS, async () => { const db = await readUsers(); delete db.users[user.id]; await store.write(USERS, db, `devhub: delete account ${user.id}`); });
    return reply(200, { ok: true });
  }

  const m = /^\/api\/data\/([a-z]+)$/.exec(url.pathname);
  if (m && DOCS.has(m[1])) {
    const file = `users/${user.id}/${m[1]}.json`;
    if (req.method === 'GET') { const d = await store.read(file); return reply(200, d ? { data: d.data, version: d.version, updatedAt: d.updatedAt } : { data: null, version: 0 }); }
    if (req.method === 'PUT') {
      if (limited('w:' + user.id, 240, 3600e3)) return reply(429, { error: 'Saving too often. Changes are kept on this device and will sync shortly.' });
      const b = await readBody(req);
      if (b.data === undefined) return reply(400, { error: 'Missing data.' });
      const r = await withLock(file, async () => {
        const cur = await store.read(file), version = cur ? cur.version : 0;
        if ((b.baseVersion ?? 0) !== version) return { s: 409, b: { error: 'Changed on another device.', data: cur ? cur.data : null, version } };
        const doc = { version: version + 1, updatedAt: new Date().toISOString(), data: b.data };
        await store.write(file, doc, `devhub: ${m[1]} for ${user.id}`);
        return { s: 200, b: { version: doc.version, updatedAt: doc.updatedAt } };
      });
      return reply(r.s, r.b);
    }
  }
  return reply(404, { error: 'Not found.' });
}

/* ---------------- static files ---------------- */
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm' };
const BLOCKED = /^\/(\.|node_modules|storage|android|www|assets|data)(\/|$)|^\/(server\.js|package(-lock)?\.json|capacitor\.config\.json|render\.yaml)$/;
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  if (BLOCKED.test(p) || p.includes('\0')) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); return res.end('Not found'); }
  let st; try { st = await fsp.stat(file); if (!st.isFile()) throw 0; } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
  const headers = {
    'Content-Type': MIME[ext], ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': p.startsWith('/vendor/') || p.startsWith('/icons/') ? 'public, max-age=604800' : 'no-cache'
  };
  if (ext === '.html') { headers['Content-Security-Policy'] = CSP; headers['X-Frame-Options'] = 'DENY'; }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && ext !== '.png' && st.size > 1024;
  if (gzip) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; } else headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  (gzip ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
}

/* ---------------- start ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error('[devhub]', req.method, url.pathname, e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'The server hit an error. Your changes are kept on this device; try again shortly.' }, corsHeaders(req));
    else res.end();
  }
});
server.listen(cfg.port, () => console.log(`[devhub] listening on :${cfg.port} · storage: ${store.kind}${store.kind === 'github' ? ` (${cfg.ghRepo}@${cfg.ghBranch}/${cfg.dataDir})` : ` (${cfg.storageDir})`} · registration: ${cfg.registration}`));
