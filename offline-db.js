/* DevHub offline database files — read and write the same data as JSON or SQLite.
 *
 * JSON file:   { app: "devhub", type: "devhub-database", version: 1, name, createdAt, updatedAt,
 *                tasks: { tasks: [...], projects: [...], settings: {...} }, links: [...], prefs: {...} }
 * SQLite file: tables meta, tasks, projects, links, settings (see SCHEMA below). Open it with any SQLite
 *              tool (DB Browser for SQLite, the sqlite3 CLI, DBeaver…) to query your tasks.
 */
(() => {
  'use strict';
  const VERSION = 1;
  const SCHEMA = `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due TEXT, priority INTEGER, status TEXT,
      project_id TEXT REFERENCES projects(id), tags TEXT, estimate INTEGER, spent INTEGER, timer_start TEXT,
      subtasks TEXT, repeat TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, extra TEXT);
    CREATE INDEX idx_tasks_due ON tasks(due);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE TABLE links (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT, category TEXT, notes TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIEW open_tasks AS SELECT id, title, due, priority, status, project_id, tags FROM tasks WHERE deleted = 0 AND status <> 'done' ORDER BY due IS NULL, due, priority;`;
  const TASK_COLS = { id: 'id', title: 'title', notes: 'notes', due: 'due', priority: 'priority', status: 'status', project: 'project_id', tags: 'tags', estimate: 'estimate', spent: 'spent', timerStart: 'timer_start', subtasks: 'subtasks', repeat: 'repeat', createdAt: 'created_at', updatedAt: 'updated_at', completedAt: 'completed_at', deleted: 'deleted' };

  let sqlPromise;
  function loadSql() {
    if (!sqlPromise) {
      sqlPromise = new Promise((resolve, reject) => {
        if (window.initSqlJs) return resolve();
        const s = document.createElement('script');
        s.src = 'vendor/sql-wasm.js'; s.onload = resolve;
        s.onerror = () => reject(new Error('The SQLite engine could not be loaded. Check your connection and try again.'));
        document.head.appendChild(s);
      }).then(() => window.initSqlJs({ locateFile: f => 'vendor/' + f }));
      sqlPromise.catch(() => { sqlPromise = null; });
    }
    return sqlPromise;
  }

  const emptyDocs = () => ({ tasks: { tasks: [], projects: [], settings: { dailyGoal: 5 } }, links: [], prefs: {} });
  function normalize(d) {
    const out = emptyDocs();
    if (d.tasks && Array.isArray(d.tasks.tasks)) out.tasks = { projects: [], settings: { dailyGoal: 5 }, ...d.tasks };
    else if (Array.isArray(d.tasks)) out.tasks.tasks = d.tasks;
    if (Array.isArray(d.links)) out.links = d.links;
    if (d.prefs && typeof d.prefs === 'object') out.prefs = d.prefs;
    return out;
  }

  /* ---------- write ---------- */
  async function encode(format, docs, meta = {}) {
    const now = new Date().toISOString();
    if (format === 'json') {
      const body = { app: 'devhub', type: 'devhub-database', version: VERSION, name: meta.name || 'DevHub', createdAt: meta.createdAt || now, updatedAt: now, tasks: docs.tasks, links: docs.links || [], prefs: docs.prefs || {} };
      return new Blob([JSON.stringify(body, null, 2) + '\n'], { type: 'application/json' });
    }
    const SQL = await loadSql(), db = new SQL.Database();
    try {
      db.run(SCHEMA);
      db.run('BEGIN');
      const m = db.prepare('INSERT INTO meta VALUES (?, ?)');
      [['app', 'devhub'], ['type', 'devhub-database'], ['version', String(VERSION)], ['name', meta.name || 'DevHub'], ['created_at', meta.createdAt || now], ['updated_at', now]].forEach(r => m.run(r));
      m.free();
      const t = docs.tasks || {};
      const p = db.prepare('INSERT OR REPLACE INTO projects VALUES (?, ?, ?, ?, ?)');
      (t.projects || []).forEach(x => p.run([x.id, x.name || 'Untitled', x.color || null, x.deleted ? 1 : 0, x.updatedAt || null]));
      p.free();
      const ts = db.prepare(`INSERT OR REPLACE INTO tasks (${Object.values(TASK_COLS).join(', ')}, extra) VALUES (${Object.keys(TASK_COLS).map(() => '?').join(', ')}, ?)`);
      for (const x of t.tasks || []) {
        const extra = {}; for (const k of Object.keys(x)) if (!(k in TASK_COLS)) extra[k] = x[k];
        ts.run([x.id, x.title || 'Untitled', x.notes || '', x.due || null, x.priority ?? 3, x.status || 'todo', x.project || null,
          JSON.stringify(x.tags || []), x.estimate ?? null, Math.round(x.spent || 0), x.timerStart || null, JSON.stringify(x.subtasks || []),
          x.repeat || null, x.createdAt || null, x.updatedAt || null, x.completedAt || null, x.deleted ? 1 : 0, Object.keys(extra).length ? JSON.stringify(extra) : null]);
      }
      ts.free();
      const l = db.prepare('INSERT OR REPLACE INTO links VALUES (?, ?, ?, ?, ?, ?, ?)');
      (docs.links || []).forEach(x => l.run([x.id, x.name || '', x.url || '', x.category || 'Other', x.notes || '', x.updatedAt || null, x.deleted ? 1 : 0]));
      l.free();
      const st = db.prepare('INSERT INTO settings VALUES (?, ?)');
      Object.entries(t.settings || {}).forEach(([k, v]) => st.run(['tasks.' + k, JSON.stringify(v)]));
      st.run(['prefs', JSON.stringify(docs.prefs || {})]);
      st.free();
      db.run('COMMIT');
      return new Blob([db.export()], { type: 'application/vnd.sqlite3' });
    } finally { db.close(); }
  }

  /* ---------- read ---------- */
  const rows = (db, sql) => { const r = db.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
  const parseJson = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

  async function decode(file) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (String.fromCharCode(...head) === 'SQLite format 3\u0000') {
      const SQL = await loadSql();
      let db;
      try { db = new SQL.Database(new Uint8Array(await file.arrayBuffer())); }
      catch { throw new Error('This SQLite file is damaged or encrypted and can’t be opened.'); }
      try {
        const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name));
        if (!tables.has('tasks') || !tables.has('meta')) throw new Error('This SQLite file isn’t a DevHub database. Create a new database instead, or open one made by DevHub.');
        const meta = Object.fromEntries(rows(db, 'SELECT key, value FROM meta').map(r => [r.key, r.value]));
        if (+meta.version > VERSION) throw new Error('This database was made by a newer version of DevHub. Update the app to open it.');
        const settings = Object.fromEntries(rows(db, 'SELECT key, value FROM settings').map(r => [r.key, parseJson(r.value, null)]));
        const taskSettings = {}; for (const [k, v] of Object.entries(settings)) if (k.startsWith('tasks.')) taskSettings[k.slice(6)] = v;
        const tasks = rows(db, 'SELECT * FROM tasks').map(r => {
          const o = {}; for (const [k, c] of Object.entries(TASK_COLS)) o[k] = r[c];
          o.tags = parseJson(r.tags, []); o.subtasks = parseJson(r.subtasks, []); o.deleted = !!r.deleted; if (!o.deleted) delete o.deleted;
          o.notes ??= ''; o.spent ??= 0;
          return { ...parseJson(r.extra, {}), ...o };
        });
        const projects = rows(db, 'SELECT * FROM projects').map(r => ({ id: r.id, name: r.name, color: r.color, updatedAt: r.updated_at, ...(r.deleted ? { deleted: true } : {}) }));
        const links = tables.has('links') ? rows(db, 'SELECT * FROM links').map(r => ({ id: r.id, name: r.name, url: r.url, category: r.category, notes: r.notes, updatedAt: r.updated_at, ...(r.deleted ? { deleted: true } : {}) })) : [];
        return { format: 'sqlite', name: meta.name || file.name.replace(/\.[^.]+$/, ''), createdAt: meta.created_at, docs: normalize({ tasks: { tasks, projects, settings: { dailyGoal: 5, ...taskSettings } }, links, prefs: settings.prefs || {} }) };
      } finally { db.close(); }
    }
    let j;
    try { j = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch { throw new Error('This file isn’t valid JSON or SQLite. Choose a DevHub database (.json, .sqlite or .db).'); }
    if (!j || typeof j !== 'object' || (j.app !== 'devhub' && !j.tasks && !j.links)) throw new Error('This JSON file isn’t a DevHub database.');
    if (+j.version > VERSION) throw new Error('This database was made by a newer version of DevHub. Update the app to open it.');
    return { format: 'json', name: j.name || file.name.replace(/\.[^.]+$/, ''), createdAt: j.createdAt, docs: normalize(j) };
  }

  window.DevHubDB = { encode, decode, emptyDocs, loadSql, ext: f => f === 'sqlite' ? '.sqlite' : '.json' };
})();
