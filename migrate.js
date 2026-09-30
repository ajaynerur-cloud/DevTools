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
    if (Array.isArray(v)) { if (v.some(isObj)) out.push(path); return; } // don't descend into records
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
    return { kind, name, db, collections };
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
  return { kind, name, tree, decl, indent, collections, rootArray: Array.isArray(tree) };
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
      collections: s.collections.map(c => ({ id: c.id, name: c.name, label: c.label, count: c.count, key: guessKey(c),
        columns: c.columns.map(x => ({ name: x.name, type: x.type, pk: !!x.pk })) }))
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
  recs.forEach((r, i) => {
    const vals = [];
    for (const x of cols) { const v = toSqlite(r[x.from], declOf(x.to)); if (v !== undefined) vals.push([x.to, v]); }
    try {
      const ks = useKey ? keyStr(r[skey]) : null;
      const hit = ks != null && byKey ? byKey.get(ks) : undefined;
      if (hit !== undefined) {
        if (step.mode === 'insert-new') { rep.skipped++; return; }
        const set = vals.filter(([k]) => k !== dkey || !useRowid);
        if (!set.length) { rep.skipped++; return; }
        prep(`UPDATE ${qid(c.table)} SET ${set.map(([k]) => qid(k) + ' = ?').join(', ')} WHERE ${useRowid ? 'rowid' : qid(dkey)} = ?`).run([...set.map(x => x[1]), hit]);
        rep.updated++;
      } else {
        if (!vals.length) { rep.skipped++; return; }
        prep(`INSERT INTO ${qid(c.table)} (${vals.map(([k]) => qid(k)).join(', ')}) VALUES (${vals.map(() => '?').join(', ')})`).run(vals.map(x => x[1]));
        rep.inserted++;
        if (byKey && ks != null) byKey.set(ks, useRowid ? db.exec('SELECT last_insert_rowid()')[0].values[0][0] : ks);
      }
    } catch (e) { rep.failed++; if (rep.errors.length < 5) rep.errors.push(`Record ${i + 1}: ${e.message}${/UNIQUE|PRIMARY KEY/.test(e.message) ? ' — it already exists; choose “Update matching records” to update it instead' : ''}`); }
    if (i % 2000 === 0) progress(`${rep.src}: ${i.toLocaleString()} of ${total.toLocaleString()}`, i / total * 100);
  });
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
    const key = c.path[c.path.length - 1];
    if (!Array.isArray(parent[key])) parent[key] = parent[key] == null || parent[key] === '' ? [] : [parent[key]];
    arr = parent[key];
  } else {
    const parent = c.path.length ? getAt(T.tree, c.path.slice(0, -1)) : null;
    if (!c.path.length) arr = T.tree;
    else { const k = c.path[c.path.length - 1]; if (!Array.isArray(parent[k])) parent[k] = parent[k] == null || parent[k] === '' ? [] : [parent[k]]; arr = parent[k]; }
  }
  rep.dst = c.label;
  const types = new Map(c.columns.map(x => [x.name, x.type]));
  for (const x of cols) if (!types.has(x.to)) { types.set(x.to, null); c.columns.push({ name: x.to, type: null }); if (!rep.created) rep.newColumns.push(x.to); }
  if (step.mode === 'replace') { arr.length = 0; rep.cleared = true; }
  const useKey = step.mode === 'upsert' || step.mode === 'insert-new';
  const byKey = new Map();
  if (useKey) arr.forEach((o, i) => { if (isObj(o)) { const ks = keyStr(o[step.dstKey]); if (ks != null && !byKey.has(ks)) byKey.set(ks, i); } });
  const total = recs.length;
  recs.forEach((r, i) => {
    const o = {};
    for (const x of cols) { const v = toTree(r[x.from], types.get(x.to), T.kind, srcKind, opts); if (v !== undefined) o[x.to] = v; }
    const ks = useKey ? keyStr(r[step.srcKey]) : null, hit = ks != null ? byKey.get(ks) : undefined;
    if (hit !== undefined) {
      if (step.mode === 'insert-new') { rep.skipped++; return; }
      Object.assign(arr[hit], o); rep.updated++;
    } else {
      if (!Object.keys(o).length) { rep.skipped++; return; }
      arr.push(o); rep.inserted++;
      if (ks != null) byKey.set(ks, arr.length - 1);
    }
    if (i % 5000 === 0) progress(`${rep.src}: ${i.toLocaleString()} of ${total.toLocaleString()}`, i / total * 100);
  });
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
      const rep = { src: sc.label, dst: '', inserted: 0, updated: 0, skipped: 0, failed: 0, errors: [], newColumns: [], created: false, cleared: false, mode: step.mode };
      progress(`Migrating ${sc.label} (${recs.length.toLocaleString()} records)…`, 30);
      const c = T.kind === 'sqlite' ? sqliteApply(T, { ...step, srcName: sc.name }, recs, rep, S.kind) : treeApply(T, { ...step, srcName: sc.name }, recs, rep, S.kind, opts);
      report.push(rep); if (!touched.includes(c)) touched.push(c);
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
    return { type: 'done', blob, report, previews, notes, targetKind: T.kind, sourceKind: S.kind, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    if (T.kind === 'sqlite') { try { T.db.run('ROLLBACK'); } catch {} }
    throw e;
  } finally { if (S.db) S.db.close(); if (T.db) T.db.close(); }
}
