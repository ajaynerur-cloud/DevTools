/* DevHub file adapter — lets the offline task tracker work directly on YOUR OWN .db/.sqlite, .json or .xml file.
 *
 *  inspect(file)                 → { kind, collections: [{ id, label, count, columns: [{ name, type, pk, values? }] }] }
 *  guess(info)                   → a mapping (which collection holds tasks, which field is title/status/…, value maps)
 *  read(file, mapping)           → DevHub docs { tasks: { tasks, projects, settings }, links, prefs }
 *  write(srcBlob, docs, mapping) → Blob of the same file with the changes applied, in its own layout
 *
 * Only fields that changed are written back, so values you didn't touch keep their exact original form.
 * Fields DevHub has no place for (e.g. "rag", "reminder") are shown as extra fields on each task.
 * DevHub-only data your file has no column for (subtasks, timers, repeat…) is kept on this device.
 */
(() => {
  'use strict';
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
  const qid = s => '"' + String(s).replace(/"/g, '""') + '"';
  const norm = s => String(s).replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', parseTagValue: false, parseAttributeValue: false, trimValues: true, ignoreDeclaration: true, ignorePiTags: true, commentPropName: false };

  let fxpP;
  const loadFxp = () => fxpP ||= window.fxp ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/fxp.min.js'; s.onload = res; s.onerror = () => rej(new Error('The XML reader could not be loaded.')); document.head.appendChild(s); });

  /* ---------- the fields DevHub understands ---------- */
  const ROLES = [
    ['title', 'Title', ['title', 'name', 'subject', 'summary', 'task', 'taskname', 'text', 'todo', 'item']],
    ['status', 'Status', ['status', 'state', 'stage', 'done', 'completed', 'iscompleted', 'isdone', 'complete', 'finished', 'checked']],
    ['priority', 'Priority', ['priority', 'prio', 'importance', 'severity', 'urgency']],
    ['due', 'Due date', ['due', 'duedate', 'deadline', 'dueon', 'dueby', 'targetdate', 'enddate', 'date']],
    ['project', 'Project', ['project', 'projectname', 'list', 'category', 'area', 'group', 'folder']],
    ['notes', 'Notes', ['notes', 'note', 'description', 'desc', 'details', 'body', 'comment', 'comments', 'remarks', 'content']],
    ['tags', 'Tags', ['tags', 'labels', 'keywords']],
    ['estimate', 'Estimate (minutes)', ['estimate', 'estimatemin', 'estimateminutes', 'effort', 'duration']],
    ['createdAt', 'Created', ['createdat', 'created', 'createdon', 'creationdate', 'datecreated', 'createtime', 'createddate']],
    ['updatedAt', 'Last updated', ['updatedat', 'updated', 'modified', 'lastmodified', 'modifiedat', 'updatetime', 'modifiedon', 'updatedon', 'lastupdated']],
    ['completedAt', 'Completed on', ['completedat', 'completedon', 'donedate', 'finishedat', 'closedat', 'completiondate', 'dateclosed', 'donetime']]
  ];
  const DATE_ROLES = new Set(['due', 'createdAt', 'updatedAt', 'completedAt']);
  const DH_ONLY = ['subtasks', 'spent', 'timerStart', 'repeat', 'estimate', 'tags', 'notes', 'completedAt'];
  const VALUE_SYN = {
    done: ['done', 'completed', 'complete', 'closed', 'finished', 'resolved', 'fixed', 'shipped', 'delivered', 'yes', 'true', '1', 'y', 'x'],
    doing: ['doing', 'inprogress', 'started', 'active', 'ongoing', 'wip', 'working', 'inreview', 'review', 'underway', 'blocked', 'onhold', 'waiting'],
    todo: ['todo', 'notstarted', 'open', 'new', 'pending', 'backlog', 'planned', 'tobedone', 'notdone', 'no', 'false', '0', 'n', '']
  };
  const PRIO_SYN = { 1: ['urgent', 'critical', 'highest', 'blocker', 'p0', 'veryhigh', 'asap'], 2: ['high', 'important', 'p1', 'major'], 3: ['medium', 'med', 'normal', 'moderate', 'default', 'p2', 'average', ''], 4: ['low', 'lowest', 'minor', 'trivial', 'p3', 'p4', 'someday'] };
  const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' }, PRIO_LABEL = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

  /* ---------- open ---------- */
  // Text in any common encoding (UTF-8, UTF-8 with BOM, UTF-16 LE/BE — e.g. files saved by PowerShell or Notepad)
  async function readText(file) {
    const u = new Uint8Array(await file.arrayBuffer());
    if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder('utf-16le').decode(u.subarray(2));
    if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder('utf-16be').decode(u.subarray(2));
    if (u.length > 3 && u[1] === 0 && u[3] === 0 && u[0] && u[2]) return new TextDecoder('utf-16le').decode(u); // UTF-16 without BOM
    return new TextDecoder('utf-8').decode(u).replace(/^﻿/, '');
  }
  const hexOf = u => [...u].map(b => b.toString(16).padStart(2, '0')).join(' ');
  const asciiOf = u => [...u].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '·').join('');
  // Work out what a file is; explain clearly when it isn't something DevHub can read
  async function kindOf(file) {
    if (!file.size) throw new Error(`${file.name} is empty (0 bytes). If it’s the database of another app, that app may keep its data somewhere else — look for a bigger .db/.sqlite file next to it.`);
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer()), h16 = String.fromCharCode(...head.subarray(0, 16));
    if (h16 === 'SQLite format 3\u0000') return 'sqlite';
    const t = (await readText(file.slice(0, 4096))).trimStart();
    if (t.startsWith('<')) return /^<!doctype html|^<html/i.test(t) ? bad('is a web page (HTML), not a database — it may have been saved from a browser by mistake') : 'xml';
    if (/^[[{]/.test(t)) return 'json';
    const why =
      /^version https:\/\/git-lfs/.test(t) ? 'is a Git LFS pointer, not the real database — download the actual file (git lfs pull)' :
      head[0] === 0x1f && head[1] === 0x8b ? 'is gzip-compressed — unzip it first' :
      head[0] === 0x50 && head[1] === 0x4b ? 'is a ZIP/Office file (e.g. .xlsx or .zip) — extract the database from it first, or use Tools → Any format converter for spreadsheets' :
      /Standard (Jet|ACE) DB/.test(asciiOf(head)) ? 'is a Microsoft Access database — export the table from Access as CSV/XML first' :
      [0x13579ace, 0x13579acd, 0x13579acf].includes(new DataView(head.buffer).getUint32(0, false)) || [0xce9a5713, 0xcd9a5713, 0xcf9a5713].includes(new DataView(head.buffer).getUint32(0, false)) ? 'is a GDBM file (for example Python “shelve”), not SQLite — the other app needs to export it' :
      new DataView(head.buffer).getUint32(12, false) === 0x00061561 || new DataView(head.buffer).getUint32(12, true) === 0x00061561 || new DataView(head.buffer).getUint32(12, false) === 0x00053162 ? 'is a Berkeley DB file (for example Python “shelve”), not SQLite — the other app needs to export it' :
      /^SQLite format/.test(h16) ? 'is a SQLite file with an unsupported header' :
      file.size % 512 === 0 && entropy(head) > 5 ? 'looks like an ENCRYPTED SQLite database (e.g. SQLCipher) — DevHub can’t open encrypted databases; the other app must export it unencrypted' :
      /^[^\n]*[,;\t][^\n]*\n/.test(t) ? 'looks like CSV — convert it to JSON first with Tools → JSON ⇄ CSV, then open the JSON' :
      null;
    return bad(why || `isn’t a SQLite database, JSON or XML file. It starts with: ${asciiOf(head.subarray(0, 24))} (${hexOf(head.subarray(0, 16))})`);
    function bad(msg) { throw new Error(`${file.name} (${file.size.toLocaleString()} bytes) ${msg}.`); }
  }
  function entropy(u) { const c = new Map(); for (const b of u) c.set(b, (c.get(b) || 0) + 1); let e = 0; for (const n of c.values()) { const p = n / u.length; e -= p * Math.log2(p); } return e; }
  async function open(file) {
    const kind = await kindOf(file);
    if (kind === 'sqlite') {
      const SQL = await DevHubDB.loadSql();
      let db; try { db = new SQL.Database(new Uint8Array(await file.arrayBuffer())); db.exec('SELECT count(*) FROM sqlite_master'); } catch { throw new Error(`${file.name} is a SQLite file but it’s damaged or encrypted, so it can’t be read.`); }
      return { kind, db };
    }
    const text = await readText(file);
    if (kind === 'json') {
      let tree;
      try { tree = JSON.parse(text); }
      catch (e) { // JSON Lines: one record per line
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        try { tree = lines.map(l => JSON.parse(l)); } catch { throw new Error(`${file.name} isn’t valid JSON: ${e.message}`); }
      }
      const m = /\n([ \t]+)\S/.exec(text);
      return { kind, tree, indent: m ? (m[1][0] === '\t' ? '\t' : m[1].length) : text.trim().includes('\n') ? 2 : 0, nl: /\n\s*$/.test(text) };
    }
    await loadFxp();
    const v = fxp.XMLValidator.validate(text); if (v !== true) throw new Error(`${file.name}: XML error on line ${v.err.line}: ${v.err.msg}`);
    const m = /\n([ \t]+)</.exec(text);
    return { kind, nl: /\n\s*$/.test(text), tree: new fxp.XMLParser(XML_OPTS).parse(text), decl: (/^\s*(<\?xml[^>]*\?>)/.exec(text) || [])[1] || null, indent: m ? m[1] : '  ' };
  }
  const getAt = (tree, path) => path.reduce((o, k) => o == null ? o : o[k], tree);
  function collectionsOf(st) {
    if (st.kind === 'sqlite') {
      const q = sql => { const r = st.db.exec(sql)[0]; return r ? r.values : []; };
      return q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(([t]) => {
        const cols = q(`PRAGMA table_info(${qid(t)})`).map(([, n, type, , , pk]) => ({ name: n, type: type || '', pk: +pk }));
        let r; try { r = st.db.exec(`SELECT rowid AS "__rowid", * FROM ${qid(t)}`)[0]; } catch { r = st.db.exec(`SELECT * FROM ${qid(t)}`)[0]; }
        const recs = r ? r.values.map(v => Object.fromEntries(r.columns.map((k, i) => [k, v[i]]))) : [];
        return { id: 't:' + t, label: t, table: t, columns: cols, recs };
      });
    }
    const out = [];
    const walk = (v, path, d) => {
      if (d > 10 || v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) { if (v.some(isObj)) out.push(path); return; }
      for (const [k, x] of Object.entries(v)) if (!k.startsWith('@') && k !== '#text') walk(x, [...path, k], d + 1);
    };
    walk(st.tree, [], 0);
    if (st.kind === 'xml') { // a single <task> isn't an array after parsing
      const walk1 = (v, path, d) => { if (d > 10 || !isObj(v)) return; for (const [k, x] of Object.entries(v)) { if (k.startsWith('@')) continue; const p = [...path, k]; if (isObj(x) && path.length && !out.some(o => o.join() === p.join()) && Object.values(x).every(y => !isObj(y) && !Array.isArray(y))) out.push(p); else walk1(x, p, d + 1); } };
      walk1(st.tree, [], 0);
    }
    return out.map(p => {
      const v = getAt(st.tree, p), recs = (Array.isArray(v) ? v : [v]).filter(isObj);
      const names = []; for (const r of recs.slice(0, 2000)) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
      const columns = names.map(n => { const t = recs.map(r => r[n]).find(x => x != null && x !== ''); return { name: n, type: t == null ? '' : Array.isArray(t) ? 'array' : typeof t, pk: 0 }; });
      return { id: 'p:' + JSON.stringify(p), label: p.length ? p.join(' › ') : '(root list)', path: p, columns, recs };
    });
  }

  async function inspect(file) {
    const st = await open(file);
    try {
      const cols = collectionsOf(st);
      return {
        kind: st.kind, name: file.name,
        collections: cols.map(c => ({ id: c.id, label: c.label, count: c.recs.length,
          columns: c.columns.map(col => {
            const seen = new Map(); let many = false;
            for (const r of c.recs) { const v = r[col.name]; if (v instanceof Uint8Array || isObj(v) || Array.isArray(v)) { many = true; break; } const k = v == null ? '' : String(v); if (k.length > 60) { many = true; break; } const e = seen.get(k); e ? e.n++ : seen.set(k, { v: v ?? '', s: k, n: 1 }); if (seen.size > 30) { many = true; break; } }
            return { ...col, sample: c.recs.map(r => r[col.name]).filter(x => x != null && x !== '').slice(0, 3).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)), values: many ? null : [...seen.values()].sort((a, b) => b.n - a.n) };
          }),
          // first rows, for showing the file's contents before migrating
          rows: c.recs.slice(0, 200).map(r => c.columns.map(col => { const v = r[col.name]; return v == null ? '' : v instanceof Uint8Array ? `(${v.length} bytes)` : typeof v === 'object' ? JSON.stringify(v) : String(v); })) }))
      };
    } finally { if (st.db) st.db.close(); }
  }

  // Fingerprint of a file's layout, so the same kind of file reuses its mapping
  const fingerprint = (info, colId) => { const c = info.collections.find(x => x.id === colId); return [info.kind, colId, ...(c ? c.columns.map(x => x.name).sort() : [])].join('|'); };

  /* ---------- guess a mapping ---------- */
  function scoreCollection(c) {
    const names = c.columns.map(x => norm(x.name));
    return ROLES.reduce((s, [r, , syn]) => s + (names.some(n => syn.includes(n)) ? (r === 'title' ? 5 : r === 'status' ? 3 : 1) : 0), 0) + Math.min(2, c.count / 50);
  }
  function guessRoles(c) {
    const roles = {}, used = new Set();
    for (const [role, , syn] of ROLES) {
      let hit = null;
      for (const s of syn) { hit = c.columns.find(x => !used.has(x.name) && norm(x.name) === s); if (hit) break; }
      if (!hit && role === 'title') hit = c.columns.find(x => !used.has(x.name) && !x.pk && /text|char|string|^$/i.test(x.type) && !/id$/i.test(x.name));
      if (hit) { roles[role] = hit.name; used.add(hit.name); }
    }
    return roles;
  }
  const guessKey = c => (c.columns.find(x => x.pk === 1) || c.columns.find(x => ['id', 'uuid', 'guid', 'key', 'taskid', '_id'].includes(norm(x.name))) || {}).name || null;
  function guessStatusMap(values) {
    const map = {};
    for (const x of values || []) { const n = norm(x.s); map[x.s] = Object.keys(VALUE_SYN).find(k => VALUE_SYN[k].includes(n)) || (/done|complet|clos|finish/.test(n) ? 'done' : /progress|start|doing|review|block|hold|wait/.test(n) ? 'doing' : 'todo'); }
    return map;
  }
  function guessPrioMap(values) {
    const map = {}, nums = (values || []).filter(x => x.s !== '').every(x => /^\d+$/.test(x.s));
    for (const x of values || []) {
      const n = norm(x.s);
      if (nums && x.s !== '') { const k = +x.s; map[x.s] = k <= 1 ? 1 : k === 2 ? 2 : k === 3 ? 3 : 4; continue; }
      map[x.s] = +(Object.keys(PRIO_SYN).find(k => PRIO_SYN[k].includes(n)) || 3);
    }
    return map;
  }
  // DevHub value → what to write in the file (first file value mapped to it, else a sensible default)
  function outMap(inMap, values, keys, labels) {
    const out = {};
    for (const k of keys) {
      const hit = (values || []).find(x => String(inMap[x.s]) === String(k) && x.s !== '');
      out[k] = hit ? hit.v : null;
    }
    const sample = (values || []).find(x => x.s !== '');
    const numeric = sample && typeof sample.v === 'number', boolish = sample && (typeof sample.v === 'boolean' || (values.every(x => ['0', '1', 'true', 'false', ''].includes(x.s.toLowerCase()))));
    for (const k of keys) if (out[k] == null) {
      if (keys.length === 3 && boolish) out[k] = k === 'done' ? (typeof sample.v === 'boolean' ? true : typeof sample.v === 'number' ? 1 : 'true') : out.todo ?? (typeof sample.v === 'boolean' ? false : typeof sample.v === 'number' ? 0 : 'false');
      else if (keys.length === 4 && numeric) out[k] = +k;
      else { const strs = (values || []).map(x => x.s).filter(x => /[a-z]/i.test(x)); const l = labels[k];
        out[k] = strs.length && strs.every(x => x === x.toLowerCase()) ? l.toLowerCase() : strs.length && strs.every(x => x === x.toUpperCase()) ? l.toUpperCase() : l; } // follow the file's letter case
    }
    return out;
  }
  function detectFormat(samples, role) {
    const s = samples.map(String).filter(Boolean);
    if (!s.length) return role === 'due' ? 'date' : null;
    const all = re => s.every(x => re.test(x));
    if (all(/^\d{4}-\d{2}-\d{2}$/)) return 'date';
    if (all(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)) return 'localT';
    if (all(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) return 'localS';
    if (all(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)) return 'localTm';
    if (all(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/)) return 'iso';
    if (all(/^\d{10}$/)) return 'epoch';
    if (all(/^\d{13}$/)) return 'epochms';
    if (all(/^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/)) return s.some(x => +x.split(/[/.-]/)[1] > 12) ? 'mdy' : 'dmy';
    return 'iso';
  }
  function guess(info, colId) {
    const c = colId ? info.collections.find(x => x.id === colId) : [...info.collections].sort((a, b) => scoreCollection(b) - scoreCollection(a))[0];
    if (!c) return null;
    const roles = guessRoles(c), col = n => c.columns.find(x => x.name === n);
    const statusMap = roles.status ? guessStatusMap(col(roles.status).values) : {};
    const prioMap = roles.priority ? guessPrioMap(col(roles.priority).values) : {};
    const formats = {};
    for (const r of DATE_ROLES) if (roles[r]) formats[r] = detectFormat(col(roles[r]).sample, r);
    const localGuess = Object.values(formats).find(f => f && f.startsWith('local')) || 'iso';
    for (const r of DATE_ROLES) if (roles[r] && !formats[r]) formats[r] = r === 'due' ? 'date' : localGuess;
    const tagsCol = roles.tags && col(roles.tags);
    return {
      collection: c.id, key: guessKey(c), roles, formats, statusMap, prioMap,
      statusOut: roles.status ? outMap(statusMap, col(roles.status).values, ['todo', 'doing', 'done'], STATUS_LABEL) : null,
      prioOut: roles.priority ? outMap(prioMap, col(roles.priority).values, [1, 2, 3, 4], PRIO_LABEL) : null,
      tagStyle: tagsCol ? (tagsCol.type === 'array' ? 'array' : tagsCol.sample.some(x => x.trim().startsWith('[')) ? 'json' : 'comma') : null,
      fingerprint: fingerprint(info, c.id)
    };
  }
  // Complete a mapping edited in the UI (recompute reverse value maps)
  function finish(info, m) {
    const c = info.collections.find(x => x.id === m.collection), col = n => c.columns.find(x => x.name === n);
    if (m.roles.status) m.statusOut = outMap(m.statusMap, col(m.roles.status).values, ['todo', 'doing', 'done'], STATUS_LABEL);
    else m.statusOut = null;
    if (m.roles.priority) m.prioOut = outMap(m.prioMap, col(m.roles.priority).values, [1, 2, 3, 4], PRIO_LABEL);
    else m.prioOut = null;
    for (const r of DATE_ROLES) if (m.roles[r]) m.formats[r] ||= detectFormat(col(m.roles[r]).sample, r);
    const tagsCol = m.roles.tags && col(m.roles.tags);
    m.tagStyle = tagsCol ? (tagsCol.type === 'array' ? 'array' : tagsCol.sample.some(x => x.trim().startsWith('[')) ? 'json' : 'comma') : null;
    m.fingerprint = fingerprint(info, c.id);
    return m;
  }

  /* ---------- value conversion file ⇄ DevHub ---------- */
  const pad = n => String(n).padStart(2, '0');
  function fromFileDate(v, fmt, dateOnly) {
    if (v == null || v === '') return null;
    let d, s = String(v).trim();
    if (fmt === 'epoch' || fmt === 'epochms' || (typeof v === 'number' && !fmt?.startsWith('d'))) { const n = +s; d = new Date(n < 1e11 ? n * 1000 : n); }
    else if (fmt === 'dmy' || fmt === 'mdy') { const [a, b, y] = s.split(/[/.-]/).map(Number); d = fmt === 'dmy' ? new Date(y, b - 1, a) : new Date(y, a - 1, b); }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { if (dateOnly) return s; d = new Date(s + 'T00:00:00'); }
    else d = new Date(s.replace(' ', 'T'));
    if (isNaN(d)) return dateOnly ? null : null;
    return dateOnly ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : d.toISOString();
  }
  function toFileDate(v, fmt) {
    if (v == null || v === '') return '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
    if (isNaN(d)) return v;
    const D = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, T = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    switch (fmt) {
      case 'date': return D;
      case 'localT': return D + 'T' + T;
      case 'localS': return D + ' ' + T;
      case 'localTm': return D + 'T' + T.slice(0, 5);
      case 'epoch': return Math.round(d.getTime() / 1000);
      case 'epochms': return d.getTime();
      case 'dmy': return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
      case 'mdy': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
      default: return d.toISOString();
    }
  }
  const parseTags = v => { if (v == null || v === '') return []; if (Array.isArray(v)) return v.map(String); const s = String(v).trim(); if (s.startsWith('[')) { try { return JSON.parse(s).map(String); } catch {} } return s.split(/[,;]/).map(x => x.trim().replace(/^#/, '')).filter(Boolean); };
  const tagsOut = (tags, style) => style === 'array' ? tags : style === 'json' ? JSON.stringify(tags) : tags.join(', ');
  const projectId = name => 'proj:' + String(name).trim().toLowerCase();

  // DevHub task → the value written for each mapped role (compared to _base to find changes)
  function fileValues(t, m, projects) {
    const r = m.roles, out = {};
    if (r.title) out.title = t.title;
    if (r.status) out.status = m.statusOut[t.status];
    if (r.priority) out.priority = m.prioOut[t.priority];
    if (r.due) out.due = toFileDate(t.due, m.formats.due);
    if (r.project) { const p = projects.find(x => x.id === t.project && !x.deleted); out.project = p ? p.name : ''; }
    if (r.notes) out.notes = t.notes || '';
    if (r.tags) out.tags = tagsOut(t.tags || [], m.tagStyle);
    if (r.estimate) out.estimate = t.estimate ?? null;
    for (const k of ['createdAt', 'updatedAt', 'completedAt']) if (r[k]) out[k] = toFileDate(t[k], m.formats[k]);
    return out;
  }
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

  /* ---------- device-side extras (subtasks, timers… that the file has no column for) ---------- */
  const sideKey = m => 'devhub:side:' + m.fingerprint;
  const loadSide = m => { try { return JSON.parse(localStorage.getItem(sideKey(m))) || {}; } catch { return {}; } };
  const saveSide = (m, s) => { try { localStorage.setItem(sideKey(m), JSON.stringify(s)); } catch {} };

  /* ---------- read ---------- */
  async function read(file, m) {
    const st = await open(file);
    try {
      const c = collectionsOf(st).find(x => x.id === m.collection);
      if (!c) throw new Error('The tasks table/collection chosen for this file wasn’t found. Set up the file again.');
      const r = m.roles, side = loadSide(m), mapped = new Set([m.key, ...Object.values(r)].filter(Boolean));
      const projects = new Map(), colors = side.__colors || {};
      const COL = ['#3346D3', '#1F8A5B', '#C23B3B', '#B7791F', '#7C3AED', '#0E7490', '#DB2777', '#4B5563'];
      const tasks = c.recs.map((rec, i) => {
        const key = m.key ? rec[m.key] : rec.__rowid ?? i;
        delete rec.__rowid;
        const t = { id: m.key ? String(key) : 'row:' + key, title: '', notes: '', due: null, priority: 3, status: 'todo', project: null, tags: [], estimate: null, spent: 0, timerStart: null, subtasks: [], repeat: null, createdAt: null, updatedAt: null, completedAt: null };
        if (r.title) t.title = rec[r.title] == null ? '' : String(rec[r.title]);
        if (r.status) { const v = String(rec[r.status] ?? ''); t.status = m.statusMap[v] || guessStatusMap([{ s: v }])[v] || 'todo'; } // values added later (e.g. by DevHub) are recognised too
        if (r.priority) { const v = String(rec[r.priority] ?? ''); t.priority = +(m.prioMap[v] ?? guessPrioMap([{ s: v }])[v]) || 3; }
        if (r.due) t.due = fromFileDate(rec[r.due], m.formats.due, true);
        if (r.notes) t.notes = rec[r.notes] == null ? '' : String(rec[r.notes]);
        if (r.tags) t.tags = parseTags(rec[r.tags]);
        if (r.estimate) t.estimate = rec[r.estimate] === '' || rec[r.estimate] == null || isNaN(+rec[r.estimate]) ? null : Math.round(+rec[r.estimate]);
        for (const k of ['createdAt', 'updatedAt', 'completedAt']) if (r[k]) t[k] = fromFileDate(rec[r[k]], m.formats[k], false);
        if (r.project) { const name = rec[r.project] == null ? '' : String(rec[r.project]).trim(); if (name) { const id = projectId(name); if (!projects.has(id)) projects.set(id, { id, name, color: colors[id] || COL[projects.size % COL.length], updatedAt: new Date(0).toISOString() }); t.project = id; } }
        const now = new Date().toISOString();
        t.createdAt ||= t.updatedAt || now; t.updatedAt ||= t.createdAt;
        if (t.status === 'done' && !t.completedAt) t.completedAt = t.updatedAt;
        const extra = {}; for (const [k, v] of Object.entries(rec)) if (!mapped.has(k)) extra[k] = v instanceof Uint8Array ? null : v;
        t.fields = extra;
        Object.assign(t, side[String(key)] || {}); // subtasks, timer… kept on this device
        t._key = key; t._base = fileValues(t, m, [...projects.values()]); t._fbase = { ...extra };
        return t;
      });
      // choices for extra fields (shown as dropdowns in the task details)
      const choices = {};
      for (const col of c.columns) if (!mapped.has(col.name)) { const vals = [...new Set(c.recs.map(x => x[col.name]).filter(v => v != null && v !== '' && typeof v !== 'object').map(String))]; if (vals.length && vals.length <= 12 && vals.length < c.recs.length) choices[col.name] = vals; }
      return { docs: { tasks: { tasks, projects: [...projects.values()], settings: { dailyGoal: side.__goal || 5 } }, links: [], prefs: {} }, choices, extraFields: c.columns.filter(x => !mapped.has(x.name)).map(x => x.name) };
    } finally { if (st.db) st.db.close(); }
  }

  /* ---------- write back ---------- */
  function coerce(v, like) { // keep the file's own types (numbers stay numbers, booleans stay booleans)
    return v == null ? (like === 'sqlite' ? null : '') : v; // empty text stays '' like the rest of the file
  }
  async function write(src, docs, m) {
    const st = await open(src);
    try {
      const c = collectionsOf(st).find(x => x.id === m.collection);
      if (!c) throw new Error('The tasks table/collection wasn’t found in the file any more.');
      const d = docs.tasks, r = m.roles, projects = d.projects || [], side = loadSide(m);
      const roleCol = Object.fromEntries(Object.entries(r).filter(([, v]) => v));
      let changed = 0, added = 0, removed = 0;
      const recOut = t => { // full record for a new task
        const fv = fileValues(t, m, projects), o = {};
        for (const [role, col] of Object.entries(roleCol)) o[col] = coerce(fv[role], st.kind);
        for (const [k, v] of Object.entries(t.fields || {})) o[k] = v === '' && st.kind === 'sqlite' ? null : v;
        return o;
      };
      const diff = t => { // only what changed since it was read/saved
        const fv = fileValues(t, m, projects), o = {};
        for (const [role, col] of Object.entries(roleCol)) if (!same(fv[role], t._base?.[role])) o[col] = coerce(fv[role], st.kind);
        for (const [k, v] of Object.entries(t.fields || {})) if (!same(v, t._fbase?.[k])) o[k] = v === '' && st.kind === 'sqlite' ? null : v;
        return o;
      };
      const settle = t => { t._base = fileValues(t, m, projects); t._fbase = { ...(t.fields || {}) }; };

      if (st.kind === 'sqlite') {
        const db = st.db, table = qid(c.table), cols = new Set(c.columns.map(x => x.name));
        const intPk = m.key && c.columns.find(x => x.name === m.key && x.pk === 1 && /INT/i.test(x.type));
        db.run('BEGIN');
        for (const t of d.tasks) {
          if (t.deleted) { if (t._key != null && !t._gone) { db.run(`DELETE FROM ${table} WHERE ${m.key ? qid(m.key) : 'rowid'} = ?`, [t._key]); t._gone = true; removed++; } continue; }
          if (t._key == null || t._gone) {
            const o = recOut(t);
            if (m.key && !intPk) o[m.key] = t._key ?? t.id;
            const ks = Object.keys(o).filter(k => cols.has(k));
            db.run(`INSERT INTO ${table} (${ks.map(qid).join(', ')}) VALUES (${ks.map(() => '?').join(', ')})`, ks.map(k => toSql(o[k])));
            t._key = m.key && !intPk ? o[m.key] : db.exec('SELECT last_insert_rowid()')[0].values[0][0];
            t._gone = false; settle(t); added++; continue;
          }
          const o = diff(t), ks = Object.keys(o).filter(k => cols.has(k));
          if (ks.length) { db.run(`UPDATE ${table} SET ${ks.map(k => qid(k) + ' = ?').join(', ')} WHERE ${m.key ? qid(m.key) : 'rowid'} = ?`, [...ks.map(k => toSql(o[k])), t._key]); changed++; }
          settle(t);
        }
        db.run('COMMIT');
        var blob = new Blob([db.export()], { type: 'application/vnd.sqlite3' });
      } else {
        const parent = c.path.length ? getAt(st.tree, c.path.slice(0, -1)) : null, k = c.path[c.path.length - 1];
        if (parent && !Array.isArray(parent[k])) parent[k] = parent[k] == null || parent[k] === '' ? [] : [parent[k]];
        const arr = c.path.length ? parent[k] : st.tree;
        const index = new Map(); arr.forEach((rec, i) => { if (isObj(rec)) index.set(String(m.key ? rec[m.key] : i), rec); });
        const nums = m.key && arr.every(x => !isObj(x) || /^\d+$/.test(String(x[m.key] ?? '')));
        let next = nums ? Math.max(0, ...arr.map(x => +(isObj(x) ? x[m.key] : 0) || 0)) + 1 : 0;
        const drop = new Set();
        for (const t of d.tasks) {
          const rec = t._key != null ? index.get(String(t._key)) : null;
          if (t.deleted) { if (rec && !t._gone) { drop.add(rec); t._gone = true; removed++; } continue; }
          if (!rec || t._gone) {
            const o = recOut(t);
            if (m.key) { if (t._key == null) t._key = nums ? next++ : t.id; o[m.key] = st.kind === 'xml' ? String(t._key) : t._key; }
            const order = c.columns.map(x => x.name), full = {};
            for (const n of order) if (n in o) full[n] = o[n]; else if (st.kind === 'json') full[n] = n === m.key ? o[n] : '';
            for (const [n, v] of Object.entries(o)) if (!(n in full)) full[n] = v;
            if (st.kind === 'xml') for (const n of Object.keys(full)) if (full[n] === '' || full[n] == null) delete full[n];
            arr.push(full); if (!m.key) t._key = arr.length - 1;
            index.set(String(t._key), full); t._gone = false; settle(t); added++; continue;
          }
          const o = diff(t);
          if (Object.keys(o).length) { for (const [n, v] of Object.entries(o)) { if (st.kind === 'xml' && (v === '' || v == null)) delete rec[n]; else rec[n] = st.kind === 'xml' && typeof v !== 'object' ? String(v) : v; } changed++; }
          settle(t);
        }
        if (drop.size) { const keep = arr.filter(x => !drop.has(x)); arr.length = 0; arr.push(...keep); if (!m.key) d.tasks.forEach(t => { if (!t._gone) t._key = arr.indexOf(index.get(String(t._key))); }); }
        if (st.kind === 'json') var blob = new Blob([JSON.stringify(st.tree, null, st.indent) + (st.nl ? '\n' : '')], { type: 'application/json' });
        else {
          const b = new fxp.XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', format: true, indentBy: st.indent || '  ', suppressEmptyNode: true });
          var blob = new Blob([(st.decl || '<?xml version="1.0" encoding="UTF-8"?>') + '\n' + b.build(st.tree).replace(/^\n+/, '')], { type: 'application/xml' });
        }
      }
      // keep DevHub-only data on this device
      const keep = {};
      for (const t of d.tasks) if (!t.deleted && t._key != null) {
        const x = {}; for (const f of DH_ONLY) { if (f === 'estimate' && r.estimate) continue; if (f === 'tags' && r.tags) continue; if (f === 'notes' && r.notes) continue; if (f === 'completedAt' && r.completedAt) continue; if (f === 'completedAt' && !r.status) continue;
          const v = t[f]; if (v != null && !(Array.isArray(v) && !v.length) && v !== 0 && v !== '') x[f] = v; }
        if (!r.priority && t.priority !== 3) x.priority = t.priority;
        if (!r.status && t.status !== 'todo') x.status = t.status;
        if (!r.due && t.due) x.due = t.due;
        if (!r.project && t.project) x.project = t.project;
        if (Object.keys(x).length) keep[String(t._key)] = x;
      }
      keep.__colors = Object.fromEntries(projects.map(p => [p.id, p.color])); keep.__goal = d.settings?.dailyGoal;
      saveSide(m, keep);
      return { blob, changed, added, removed };
    } finally { if (st.db) st.db.close(); }
  }
  const toSql = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;

  // Status / priority names to show in the tracker: the file's own words
  function labels(m) {
    const words = (out, keys, def) => Object.fromEntries(keys.map(k => { const v = out && out[k]; return [k, typeof v === 'string' && v.trim() && !/^(true|false|0|1)$/i.test(v) ? v : def[k]]; }));
    return { status: words(m.statusOut, ['todo', 'doing', 'done'], STATUS_LABEL), priority: words(m.prioOut, [1, 2, 3, 4], PRIO_LABEL) };
  }

  window.DevHubAdapter = { inspect, guess, finish, read, write, labels, fingerprint, guessStatusMap, guessPrioMap, detectFormat, ROLES, STATUS_LABEL, PRIO_LABEL };
})();
