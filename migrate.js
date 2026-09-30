/* DevHub migrate engine — merges records from one .db/.sqlite, .json or .xml file into an EXISTING
 * .db/.sqlite, .json or .xml file (any combination). Loaded on demand by worker.js, so it shares
 * worker.js globals: need(), progress(), infer(), xmlName(), sqlType(), MIME.
 *
 *   { kind: 'inspect', source, name }                         → { type: 'done', info }
 *   { kind: 'migrate', source, sourceName, target, targetName, plan, opts } → { type: 'done', blob, report, previews, ... }
 *
 * A "collection" is a table (SQLite) or an array of records at some path (JSON/XML).
 * Only the target is changed: existing rows/fields the plan doesn't touch are kept as they were.
 */
'use strict';

let SQLmod = null;
async function sqlite() {
  if (!SQLmod) { importScripts('vendor/sql-wasm.js'); SQLmod = await initSqlJs({ locateFile: f => 'vendor/' + f }); }
  return SQLmod;
}
const SQLITE_EXT = /\.(db|db3|sqlite|sqlite3|s3db|sl3)$/i;
const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
const norm = s => String(s).replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const keyStr = v => v == null || v === '' ? null : String(typeof v === 'object' ? JSON.stringify(v) : v).trim();
const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', parseTagValue: false, parseAttributeValue: false, trimValues: true, ignoreDeclaration: true, ignorePiTags: true, commentPropName: false };

/* ---------- open a file as a "store" ---------- */
async function detectKind(blob, name) {
  if (blob.size === 0) {
    if (SQLITE_EXT.test(name)) return 'sqlite';
    if (/\.xml$/i.test(name)) return 'xml';
    if (/\.json$/i.test(name)) return 'json';
    throw new Error(`${name} is empty. Give it a .db, .json or .xml name so DevHub knows what to create.`);
  }
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (String.fromCharCode(...head) === 'SQLite format 3\u0000') return 'sqlite';
  const t = (await blob.slice(0, 1024).text()).replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return 'xml';
  if (/^[[{]/.test(t)) return 'json';
  if (SQLITE_EXT.test(name)) throw new Error(`${name} isn’t a SQLite database (it may be encrypted, or a different database engine’s file).`);
  throw new Error(`${name} isn’t a SQLite database, JSON or XML file.`);
}

function colTypesOf(records) {
  const tally = new Map(), order = [];
  for (const r of records.slice(0, 2000)) {
    if (!isObj(r)) continue;
    for (const [k, v] of Object.entries(r)) {
      if (!tally.has(k)) { tally.set(k, {}); order.push(k); }
      if (v == null || v === '') continue;
      const t = Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;
      const m = tally.get(k); m[t] = (m[t] || 0) + 1;
    }
  }
  return order.map(k => { const m = tally.get(k); const t = Object.keys(m).sort((a, b) => m[b] - m[a])[0] || null; return { name: k, type: t }; });
}

function getAt(tree, path) { return path.reduce((o, k) => o == null ? o : o[k], tree); }
function findCollections(tree, kind) {
  const out = [];
  const walk = (v, path, d) => {
    if (d > 10 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { if (!v.length || v.some(isObj)) out.push(path); return; } // empty lists count too; don't descend into records
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('@') && k !== '#text') walk(x, [...path, k], d + 1);
  };
  walk(tree, [], 0);
  if (!out.length) { // no repeating records: offer single "record-like" objects (e.g. an XML file with one <book>)
    const walk1 = (v, path, d) => {
      if (d > 10 || !isObj(v)) return;
      const vals = Object.values(v);
      if (path.length > (kind === 'xml' ? 1 : 0) && vals.length && vals.every(x => !isObj(x) && !Array.isArray(x))) { out.push(path); return; }
      for (const [k, x] of Object.entries(v)) if (!k.startsWith('@')) walk1(x, [...path, k], d + 1);
    };
    walk1(tree, [], 0);
  }
  return out;
}
const pathLabel = p => p.length ? p.join(' › ') : '(root array)';

async function openStore(blob, name) {
  const kind = await detectKind(blob, name);
  if (kind === 'sqlite') {
    const SQL = await sqlite();
    let db;
    try { db = blob.size ? new SQL.Database(new Uint8Array(await blob.arrayBuffer())) : new SQL.Database(); }
    catch { throw new Error(`${name} is damaged or encrypted and can’t be opened.`); }
    const q = sql => { const r = db.exec(sql)[0]; return r ? r.values : []; };
    let tables;
    try { tables = q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r[0]); }
    catch { db.close(); throw new Error(`${name} isn’t a readable SQLite database.`); }
    const collections = tables.map(t => {
      const cols = q(`PRAGMA table_info(${qid(t)})`).map(([, n, type, notnull, dflt, pk]) => ({ name: n, type: type || '', pk: +pk, notnull: !!notnull, dflt }));
      return { id: 't:' + t, name: t, label: t, table: t, columns: cols, count: q(`SELECT COUNT(*) FROM ${qid(t)}`)[0][0] };
    });
    const st = { kind, name, db, collections };
    try { const m = Object.fromEntries(q('SELECT key, value FROM meta')); if (m.type === 'devhub-database') st.profile = 'devhub'; } catch {}
    applyProfile(st);
    return st;
  }
  const text = blob.size ? (await blob.text()).replace(/^﻿/, '') : '';
  let tree, decl = null, indent = 2;
  if (kind === 'json') {
    try { tree = text.trim() ? JSON.parse(text) : {}; }
    catch (e) { throw new Error(`${name} isn’t valid JSON: ${e.message}`); }
    const m = /\n([ \t]+)\S/.exec(text); indent = m ? (m[1][0] === '\t' ? '\t' : m[1].length) : text.trim() && !text.trim().includes('\n') ? 0 : 2;
  } else {
    need('fxp');
    if (text.trim()) {
      const v = fxp.XMLValidator.validate(text);
      if (v !== true) throw new Error(`${name}: XML error on line ${v.err.line}: ${v.err.msg}`);
      tree = new fxp.XMLParser(XML_OPTS).parse(text);
      decl = (/^\s*(<\?xml[^>]*\?>)/.exec(text) || [])[1] || null;
      const m = /\n([ \t]+)</.exec(text); indent = m ? m[1] : '  ';
    } else tree = { root: {} };
  }
  const collections = findCollections(tree, kind).map(p => {
    const v = getAt(tree, p), recs = Array.isArray(v) ? v : [v];
    return { id: 'p:' + JSON.stringify(p), name: p[p.length - 1] || 'records', label: pathLabel(p), path: p, columns: colTypesOf(recs), count: recs.filter(isObj).length };
  });
  const st = { kind, name, tree, decl, indent, collections, rootArray: Array.isArray(tree) };
  if (kind === 'json' && isObj(tree) && (tree.app === 'devhub' || tree.type === 'devhub-database')) {
    st.profile = 'devhub';
    // older/odd DevHub files: make sure tasks is { tasks: [], projects: [], settings }
    if (!isObj(tree.tasks)) { const list = Array.isArray(tree.tasks) ? tree.tasks.filter(x => isObj(x) && !('tasks' in x && 'projects' in x)) : []; tree.tasks = { tasks: list, projects: [], settings: { dailyGoal: 5 } }; }
    if (!Array.isArray(tree.tasks.tasks)) tree.tasks.tasks = [];
    if (!Array.isArray(tree.tasks.projects)) tree.tasks.projects = [];
    if (!Array.isArray(tree.links)) tree.links = [];
    st.collections = findCollections(tree, kind).map(p => { const v = getAt(tree, p), recs = Array.isArray(v) ? v : [v];
      return { id: 'p:' + JSON.stringify(p), name: p[p.length - 1] || 'records', label: pathLabel(p), path: p, columns: colTypesOf(recs), count: recs.filter(isObj).length }; });
  }
  applyProfile(st);
  return st;
}

/* ---------- DevHub database profile: known fields and allowed values, even when the target is empty ---------- */
const DH_STATUS = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
const DH_PRIO = [[1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low']];
const DH_TASK = [['id', 'string'], ['title', 'string'], ['notes', 'string'], ['due', 'string', 'date YYYY-MM-DD'], ['priority', 'number', null, DH_PRIO], ['status', 'string', null, DH_STATUS],
  ['project', 'string', 'project name — linked to a DevHub project automatically'], ['tags', 'array', 'list, or text separated by commas'], ['estimate', 'number', 'minutes'], ['spent', 'number', 'seconds'],
  ['repeat', 'string'], ['createdAt', 'string'], ['updatedAt', 'string'], ['completedAt', 'string']];
const DH_LINK = [['id', 'string'], ['name', 'string'], ['url', 'string'], ['category', 'string'], ['notes', 'string']];
const DH_PROJECT = [['id', 'string'], ['name', 'string'], ['color', 'string']];
const DH_SQL = { project_id: 'project', created_at: 'createdAt', updated_at: 'updatedAt', completed_at: 'completedAt', timer_start: 'timerStart' };
function applyProfile(st) {
  if (st.profile !== 'devhub') return;
  for (const c of st.collections) {
    const which = st.kind === 'sqlite' ? c.table : c.path.join('.');
    const spec = { tasks: DH_TASK, 'tasks.tasks': DH_TASK, links: DH_LINK, projects: DH_PROJECT, 'tasks.projects': DH_PROJECT }[which];
    if (!spec) continue;
    c.devhub = which.endsWith('projects') ? 'projects' : which.endsWith('links') ? 'links' : 'tasks';
    if (st.kind === 'sqlite') {
      for (const col of c.columns) { col.known = true; const f = spec.find(x => x[0] === (DH_SQL[col.name] || col.name)); if (f) { if (f[2]) col.hint = f[2]; if (f[3]) col.choices = f[3]; } }
      if (c.devhub === 'tasks') { const pc = c.columns.find(x => x.name === 'project_id'); if (pc) pc.hint = 'project name — linked to a DevHub project automatically'; }
    } else {
      const have = new Map(c.columns.map(x => [x.name, x]));
      c.columns = spec.map(([n, t, hint, choices]) => ({ ...(have.get(n) || {}), name: n, type: t, known: true, ...(hint ? { hint } : {}), ...(choices ? { choices } : {}) }))
        .concat(c.columns.filter(x => !spec.some(f => f[0] === x.name)));
    }
  }
}
const devhubUid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const PROJECT_COLORS = ['#3346D3', '#1F8A5B', '#D97706', '#C23B3B', '#7C3AED', '#0E7490', '#BE185D', '#4D7C0F'];
const isoDay = v => { if (v == null || v === '') return null; const s = String(v).trim(); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const d = new Date(s); return isNaN(d) ? s : d.toISOString().slice(0, 10); };
const isoTime = v => { if (v == null || v === '') return null; const s = String(v).trim(); const d = new Date(/^\d+$/.test(s) ? +s * (s.length <= 10 ? 1000 : 1) : s); return isNaN(d) ? s : d.toISOString(); };
// Make a record look like what DevHub's task tracker writes. `o` uses logical DevHub names. insert=true fills defaults.
function devhubTask(o, insert, projectId, existing) {
  if ('status' in o) { const v = String(o.status ?? '').toLowerCase(); o.status = ['todo', 'doing', 'done'].includes(v) ? v : 'todo'; }
  if ('priority' in o) { const n = +o.priority; o.priority = [1, 2, 3, 4].includes(n) ? n : 3; }
  if ('due' in o) o.due = isoDay(o.due);
  for (const k of ['createdAt', 'updatedAt', 'completedAt']) if (k in o) o[k] = isoTime(o[k]);
  if ('tags' in o && !Array.isArray(o.tags)) { const v = o.tags; o.tags = v == null || v === '' ? [] : typeof v === 'string' ? (v.trim().startsWith('[') ? (() => { try { return JSON.parse(v); } catch { return v.split(','); } })() : v.split(/[,;]/)).map(x => String(x).trim().replace(/^#/, '')).filter(Boolean) : [String(v)]; }
  if ('estimate' in o && o.estimate !== null) o.estimate = Number.isFinite(+o.estimate) ? Math.round(+o.estimate) : null;
  if ('project' in o) o.project = o.project == null || o.project === '' ? null : projectId(String(o.project));
  if ('id' in o && o.id != null) o.id = String(o.id);
  if (insert) {
    const now = new Date().toISOString();
    if (o.id == null || o.id === '') o.id = devhubUid();
    if (!o.title) o.title = 'Untitled';
    o.status ??= 'todo'; o.priority ??= 3; o.notes ??= ''; o.due ??= null; o.project ??= null; o.tags ??= []; o.estimate ??= null; o.spent ??= 0; o.subtasks ??= []; o.repeat ??= null;
    o.createdAt ??= now; o.updatedAt ??= o.createdAt;
  }
  if (o.status === 'done' && !o.completedAt && !(existing && existing.completedAt)) o.completedAt = o.updatedAt || (existing && existing.updatedAt) || o.createdAt || new Date().toISOString();
  if (o.status && o.status !== 'done' && 'status' in o) o.completedAt = null;
  if (!insert && !('updatedAt' in o)) o.updatedAt = new Date().toISOString();
  return o;
}
// Returns fn(name) → project id, creating DevHub projects for names it hasn't seen.
function projectResolver(T) {
  let list, add;
  if (T.kind === 'sqlite') {
    const r = T.db.exec('SELECT id, name, deleted FROM projects')[0];
    list = r ? r.values.map(([id, name, del]) => ({ id, name, deleted: !!del })) : [];
    add = p => T.db.run('INSERT INTO projects (id, name, color, deleted, updated_at) VALUES (?, ?, ?, 0, ?)', [p.id, p.name, p.color, p.updatedAt]);
  } else { list = T.tree.tasks.projects; add = p => list.push(p); }
  const byId = new Map(list.map(p => [String(p.id), p])), byName = new Map(list.filter(p => !p.deleted).map(p => [String(p.name).trim().toLowerCase(), p]));
  let created = 0;
  const fn = name => {
    if (byId.has(name)) return byId.get(name).id;
    const k = name.trim().toLowerCase(); if (byName.has(k)) return byName.get(k).id;
    const p = { id: devhubUid(), name: name.trim(), color: PROJECT_COLORS[(list.length + created) % PROJECT_COLORS.length], updatedAt: new Date().toISOString() };
    add(p); if (T.kind === 'sqlite') list.push(p); byName.set(k, p); byId.set(p.id, p); created++;
    return p.id;
  };
  fn.created = () => created;
  return fn;
}

function records(store, c) {
  if (store.kind === 'sqlite') {
    const r = store.db.exec(`SELECT * FROM ${qid(c.table)}`)[0];
    return r ? r.values.map(v => Object.fromEntries(r.columns.map((k, i) => [k, v[i]]))) : [];
  }
  const v = getAt(store.tree, c.path);
  return (Array.isArray(v) ? v : [v]).filter(isObj);
}

const ID_LIKE = ['id', 'uuid', 'guid', 'key', 'code', 'sku', 'email', 'username', 'slug'];
function guessKey(c) {
  const pks = (c.columns || []).filter(x => x.pk);
  if (pks.length === 1) return pks[0].name;
  for (const k of ID_LIKE) { const hit = c.columns.find(x => norm(x.name) === k); if (hit) return hit.name; }
  const suf = c.columns.find(x => /(^|_|[a-z])(id|Id|ID)$/.test(x.name));
  return suf ? suf.name : null;
}

async function inspect(job) {
  progress('Reading ' + job.name + '…', 20);
  const s = await openStore(job.source, job.name);
  try {
    const info = {
      kind: s.kind, name: s.name, rootArray: !!s.rootArray,
      profile: s.profile || null,
      collections: s.collections.map(c => {
        const recs = records(s, c);
        const cols = c.columns.map(x => {
          const out = { name: x.name, type: x.type, pk: !!x.pk, known: !!x.known, hint: x.hint || null, choices: x.choices || null };
          const seen = new Map(); let many = false;
          for (const r of recs) { const v = r[x.name]; if (v == null || v instanceof Uint8Array || typeof v === 'object') continue; const k = String(v); if (k.length > 80) { many = true; break; } seen.set(k, (seen.get(k) || 0) + 1); if (seen.size > 40) { many = true; break; } }
          if (!many && seen.size) out.values = [...seen].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));
          return out;
        });
        const show = v => v == null ? '' : v instanceof Uint8Array ? `(${v.length} bytes)` : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return { id: c.id, name: c.name, label: c.label, count: c.count, key: c.devhub === 'tasks' ? 'id' : guessKey(c), devhub: c.devhub || null, columns: cols,
          sample: recs.slice(0, 5).map(r => Object.fromEntries(c.columns.map(x => [x.name, show(r[x.name])]))) };
      })
    };
    progress('Done', 100);
    return { type: 'done', info };
  } finally { if (s.db) s.db.close(); }
}

/* ---------- value conversion ---------- */
function toSqlite(v, declType) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const T = (declType || '').toUpperCase();
  if (typeof v === 'string' && /INT|REAL|FLOA|DOUB|NUM|DEC/.test(T) && NUM.test(v.trim())) return Number(v.trim());
  if (typeof v === 'string' && /BOOL/.test(T) && /^(true|false)$/i.test(v)) return /^true$/i.test(v) ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function toTree(v, ttype, targetKind, srcKind, opts) {
  if (v === undefined) return undefined;
  if (v instanceof Uint8Array) return b64(v);
  if (targetKind === 'xml') { if (v === null) return undefined; if (typeof v === 'boolean') return String(v); return v; }
  if (v === null) return null;
  const looksJson = typeof v === 'string' && /^\s*[[{]/.test(v);
  switch (ttype) {
    case 'boolean': if (v === 1 || v === '1' || /^true$/i.test(v)) return true; if (v === 0 || v === '0' || /^false$/i.test(v)) return false; return v;
    case 'number': return typeof v === 'string' && NUM.test(v.trim()) ? Number(v.trim()) : v;
    case 'string': return typeof v === 'object' ? JSON.stringify(v) : String(v);
    case 'object': case 'array': if (looksJson) { try { return JSON.parse(v); } catch {} } return v;
  }
  if (looksJson && opts.parseJson !== false) { try { return JSON.parse(v); } catch {} }
  if (srcKind === 'xml' && opts.inferTypes !== false && typeof v === 'string') { const x = infer(v); return x === null ? '' : x; }
  return v;
}

/* ---------- apply one collection plan to the target ---------- */
const mapValue = (x, v) => x.values && v != null && Object.prototype.hasOwnProperty.call(x.values, String(v)) ? x.values[String(v)] : v;
const showCell = v => v == null ? '' : v instanceof Uint8Array ? `(${v.length} bytes)` : typeof v === 'object' ? JSON.stringify(v) : String(v);
const keepSample = (rep, o, isNew) => { if (rep.samples.length < 20) rep.samples.push({ action: isNew ? 'add' : 'update', rec: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, showCell(v)])) }); };
function sqliteApply(T, step, recs, rep, srcKind) {
  const db = T.db;
  let c = step.dst === 'new' ? null : T.collections.find(x => x.id === step.dst);
  const cols = step.cols.filter(x => x.to);
  if (!c) {
    const nm = (step.newName || step.srcName || 'data').trim();
    c = T.collections.find(x => x.table.toLowerCase() === nm.toLowerCase());
    if (!c) {
      const defs = cols.map(x => `${qid(x.to)} ${sqlType(recs.slice(0, 2000).map(r => srcKind === 'xml' ? infer(r[x.from]) : r[x.from]).map(v => typeof v === 'boolean' ? 1 : v))}`);
      const keyCol = step.mode !== 'append' && step.dstKey && cols.find(x => x.to === step.dstKey);
      db.run(`CREATE TABLE ${qid(nm)} (${defs.join(', ') || '"value" TEXT'}${keyCol && new Set(recs.map(r => keyStr(r[keyCol.from]))).size === recs.length ? `, PRIMARY KEY (${qid(keyCol.to)})` : ''})`);
      c = { id: 't:' + nm, name: nm, label: nm, table: nm, columns: cols.map(x => ({ name: x.to, type: '' })), count: 0 };
      T.collections.push(c); rep.created = true;
    }
  }
  rep.dst = c.label;
  const have = new Set(c.columns.map(x => x.name.toLowerCase()));
  for (const x of cols) if (!have.has(x.to.toLowerCase())) {
    const t = sqlType(recs.slice(0, 2000).map(r => r[x.from]).map(v => typeof v === 'boolean' ? 1 : srcKind === 'xml' ? infer(v) : v));
    db.run(`ALTER TABLE ${qid(c.table)} ADD COLUMN ${qid(x.to)} ${t}`);
    c.columns.push({ name: x.to, type: t }); have.add(x.to.toLowerCase()); if (!rep.created) rep.newColumns.push(x.to);
  }
  const declOf = n => (c.columns.find(x => x.name.toLowerCase() === n.toLowerCase()) || {}).type;
  if (step.mode === 'replace') { db.run(`DELETE FROM ${qid(c.table)}`); rep.cleared = true; }
  const useKey = step.mode === 'upsert' || step.mode === 'insert-new';
  const skey = step.srcKey, dkey = step.dstKey;
  let byKey = null, useRowid = true;
  if (useKey) {
    byKey = new Map();
    let r;
    try { r = db.exec(`SELECT rowid, ${qid(dkey)} FROM ${qid(c.table)}`)[0]; }
    catch { useRowid = false; r = db.exec(`SELECT ${qid(dkey)}, ${qid(dkey)} FROM ${qid(c.table)}`)[0]; }
    if (r) for (const [rid, k] of r.values) { const ks = keyStr(k); if (ks != null && !byKey.has(ks)) byKey.set(ks, rid); }
  }
  const stmts = new Map();
  const prep = sql => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
  const total = recs.length;
  const dh = T.profile === 'devhub' && c.devhub === 'tasks' ? projectResolver(T) : null;
  const physical = new Set(c.columns.map(x => x.name));
  const toLogical = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [DH_SQL[k] || k, v]));
  const fromLogical = o => { const inv = Object.fromEntries(Object.entries(DH_SQL).map(([a, b]) => [b, a])); const out = {}; for (const [k, v] of Object.entries(o)) { const n = inv[k] || k; if (physical.has(n)) out[n] = v; } return out; };
  recs.forEach((r, i) => {
    try {
      const ks = useKey ? keyStr(r[skey]) : null;
      const hit = ks != null && byKey ? byKey.get(ks) : undefined;
      if (hit !== undefined && step.mode === 'insert-new') { rep.skipped++; return; }
      let o = {};
      for (const x of cols) { const v = mapValue(x, r[x.from]); if (v !== undefined) o[x.to] = v; }
      if (dh) { o = fromLogical(devhubTask(toLogical(o), hit === undefined, dh)); if (hit === undefined && o.id != null && byKey) { /* keep key map in sync */ } }
      const vals = Object.entries(o).map(([k, v]) => [k, toSqlite(v, declOf(k))]).filter(([, v]) => v !== undefined);
      if (hit !== undefined) {
        const set = vals.filter(([k]) => k !== dkey || !useRowid);
        if (!set.length) { rep.skipped++; return; }
        prep(`UPDATE ${qid(c.table)} SET ${set.map(([k]) => qid(k) + ' = ?').join(', ')} WHERE ${useRowid ? 'rowid' : qid(dkey)} = ?`).run([...set.map(x => x[1]), hit]);
        rep.updated++; keepSample(rep, o, false);
      } else {
        if (!vals.length) { rep.skipped++; return; }
        prep(`INSERT INTO ${qid(c.table)} (${vals.map(([k]) => qid(k)).join(', ')}) VALUES (${vals.map(() => '?').join(', ')})`).run(vals.map(x => x[1]));
        rep.inserted++; keepSample(rep, o, true);
        if (byKey && ks != null) byKey.set(ks, useRowid ? db.exec('SELECT last_insert_rowid()')[0].values[0][0] : ks);
      }
    } catch (e) { rep.failed++; if (rep.errors.length < 5) rep.errors.push(`Record ${i + 1}: ${e.message}${/UNIQUE|PRIMARY KEY/.test(e.message) ? ' — it already exists; choose “Update matching records” to update it instead' : ''}`); }
    if (i % 2000 === 0) progress(`${rep.src}: ${i.toLocaleString()} of ${total.toLocaleString()}`, i / total * 100);
  });
  if (dh) rep.projectsCreated = dh.created();
  stmts.forEach(s => s.free());
  return c;
}

function treeApply(T, step, recs, rep, srcKind, opts) {
  let c = step.dst === 'new' ? null : T.collections.find(x => x.id === step.dst);
  const cols = step.cols.filter(x => x.to);
  let arr;
  if (!c) {
    if (T.rootArray) throw new Error(`The target ${T.name} is a single JSON array, so new collections can’t be added. Choose “(root array)” as the target.`);
    let nm = (step.newName || step.srcName || 'records').trim();
    if (T.kind === 'xml') nm = xmlName(nm);
    let parent = T.tree;
    if (T.kind === 'xml') {
      const rootKey = Object.keys(T.tree).find(k => !k.startsWith('?')) || 'root';
      if (!isObj(T.tree[rootKey])) T.tree[rootKey] = T.tree[rootKey] ? { '#text': T.tree[rootKey] } : {};
      parent = T.tree[rootKey];
      c = T.collections.find(x => x.path.length === 2 && x.path[0] === rootKey && x.path[1] === nm);
      if (!c) c = { id: 'p:' + JSON.stringify([rootKey, nm]), name: nm, label: pathLabel([rootKey, nm]), path: [rootKey, nm], columns: [], count: 0 };
    } else {
      c = T.collections.find(x => x.path.length === 1 && x.path[0] === nm);
      if (!c) c = { id: 'p:' + JSON.stringify([nm]), name: nm, label: nm, path: [nm], columns: [], count: 0 };
    }
    if (!T.collections.includes(c)) { T.collections.push(c); rep.created = true; }
    let key = c.path[c.path.length - 1];
    if (parent[key] != null && parent[key] !== '' && !Array.isArray(parent[key])) {
      let n = 2; while (parent[key + '_' + n] != null) n++;
      const was = key; key = key + '_' + n; c.path = [...c.path.slice(0, -1), key]; c.name = key; c.label = pathLabel(c.path); c.id = 'p:' + JSON.stringify(c.path);
      rep.renamed = `“${was}” already exists in the target and isn’t a list, so the records were put in “${key}”.`;
    }
    if (!Array.isArray(parent[key])) parent[key] = [];
    arr = parent[key];
  } else {
    const parent = c.path.length ? getAt(T.tree, c.path.slice(0, -1)) : null;
    if (!c.path.length) arr = T.tree;
    else { const k = c.path[c.path.length - 1]; if (!Array.isArray(parent[k])) parent[k] = parent[k] == null || parent[k] === '' ? [] : isObj(parent[k]) && T.kind === 'xml' ? [parent[k]] : (() => { throw new Error(`“${c.label}” in the target isn’t a list of records.`); })(); arr = parent[k]; }
  }
  rep.dst = c.label;
  const types = new Map(c.columns.map(x => [x.name, x.type]));
  for (const x of cols) if (!types.has(x.to)) { types.set(x.to, null); c.columns.push({ name: x.to, type: null }); if (!rep.created) rep.newColumns.push(x.to); }
  if (step.mode === 'replace') { arr.length = 0; rep.cleared = true; }
  const useKey = step.mode === 'upsert' || step.mode === 'insert-new';
  const byKey = new Map();
  if (useKey) arr.forEach((o, i) => { if (isObj(o)) { const ks = keyStr(o[step.dstKey]); if (ks != null && !byKey.has(ks)) byKey.set(ks, i); } });
  const total = recs.length;
  const dh = T.profile === 'devhub' && c.devhub === 'tasks' ? projectResolver(T) : null;
  recs.forEach((r, i) => {
    const ks = useKey ? keyStr(r[step.srcKey]) : null, hit = ks != null ? byKey.get(ks) : undefined;
    if (hit !== undefined && step.mode === 'insert-new') { rep.skipped++; return; }
    let o = {};
    for (const x of cols) { const v = toTree(mapValue(x, r[x.from]), types.get(x.to), T.kind, srcKind, opts); if (v !== undefined) o[x.to] = v; }
    if (dh) o = devhubTask(o, hit === undefined, dh, hit !== undefined ? arr[hit] : null);
    if (hit !== undefined) { Object.assign(arr[hit], o); rep.updated++; keepSample(rep, o, false); }
    else {
      if (!Object.keys(o).length) { rep.skipped++; return; }
      arr.push(o); rep.inserted++; keepSample(rep, o, true);
      if (ks != null) byKey.set(ks, arr.length - 1);
    }
    if (i % 5000 === 0) progress(`${rep.src}: ${i.toLocaleString()} of ${total.toLocaleString()}`, i / total * 100);
  });
  if (dh) rep.projectsCreated = dh.created();
  return c;
}

function preview(T, c) {
  const recs = records(T, c), cols = T.kind === 'sqlite' ? c.columns.map(x => x.name) : colTypesOf(recs).map(x => x.name);
  const show = v => v == null ? '' : v instanceof Uint8Array ? `(${v.length} bytes)` : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return { label: c.label, count: recs.length, columns: cols, rows: recs.slice(-50).map(r => cols.map(k => show(r[k]))) };
}

async function migrate(job) {
  const t0 = performance.now(), opts = job.opts || {};
  progress('Opening source…', 5);
  const S = await openStore(job.source, job.sourceName);
  progress('Opening target…', 15);
  const T = await openStore(job.target, job.targetName);
  const report = [], touched = [], notes = [];
  try {
    if (T.kind === 'sqlite') T.db.run('BEGIN');
    for (const step of job.plan) {
      const sc = S.collections.find(x => x.id === step.src);
      if (!sc) throw new Error(`Source collection ${step.src} not found — re-open the source file.`);
      if ((step.mode === 'upsert' || step.mode === 'insert-new') && (!step.srcKey || !step.dstKey)) throw new Error(`${sc.label}: choose which field to match records on, or switch the mode to “Add every record”.`);
      const recs = records(S, sc);
      const rep = { src: sc.label, dst: '', inserted: 0, updated: 0, skipped: 0, failed: 0, errors: [], newColumns: [], created: false, cleared: false, mode: step.mode, samples: [] };
      progress(`Migrating ${sc.label} (${recs.length.toLocaleString()} records)…`, 30);
      const c = T.kind === 'sqlite' ? sqliteApply(T, { ...step, srcName: sc.name }, recs, rep, S.kind) : treeApply(T, { ...step, srcName: sc.name }, recs, rep, S.kind, opts);
      report.push(rep); if (!touched.includes(c)) touched.push(c);
    }
    if (job.dryRun) {
      if (T.kind === 'sqlite') T.db.run('ROLLBACK');
      progress('Done', 100);
      return { type: 'done', dryRun: true, report, notes, targetKind: T.kind, sourceKind: S.kind, profile: T.profile || null, ms: Math.round(performance.now() - t0) };
    }
    if (T.kind === 'sqlite') T.db.run('COMMIT');
    progress('Writing target file…', 90);
    let blob;
    if (T.kind === 'sqlite') blob = new Blob([T.db.export()], { type: 'application/vnd.sqlite3' });
    else if (T.kind === 'json') blob = new Blob([JSON.stringify(T.tree, null, T.indent) + '\n'], { type: MIME.json + ';charset=utf-8' });
    else {
      const b = new fxp.XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', format: true, indentBy: T.indent || '  ', suppressEmptyNode: true });
      blob = new Blob([(T.decl || '<?xml version="1.0" encoding="UTF-8"?>') + '\n' + b.build(T.tree).replace(/^\n+/, '')], { type: MIME.xml + ';charset=utf-8' });
      notes.push('XML comments and processing instructions in the target aren’t kept, and the file is re-indented.');
    }
    const previews = touched.map(c => preview(T, c));
    progress('Done', 100);
    return { type: 'done', blob, report, previews, notes, profile: T.profile || null, targetKind: T.kind, sourceKind: S.kind, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    if (T.kind === 'sqlite') { try { T.db.run('ROLLBACK'); } catch {} }
    throw e;
  } finally { if (S.db) S.db.close(); if (T.db) T.db.close(); }
}
