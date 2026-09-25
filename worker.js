/* DevHub worker — formatting and conversion run here so the UI never freezes.
 * Messages in:  { kind: 'format', ... } | { kind: 'convert', ... }
 * Messages out: { type: 'progress', text, pct } | { type: 'done', ... } | { type: 'error', message }
 */
'use strict';
const loaded = new Set();
const need = (...libs) => {
  const files = { papa: 'vendor/papaparse.min.js', xlsx: 'vendor/xlsx.full.min.js', fxp: 'vendor/fxp.min.js', yaml: 'vendor/js-yaml.min.js', beautify: 'vendor/beautifier.min.js', sql: 'vendor/sql-formatter.min.js' };
  libs.forEach(l => { if (!loaded.has(l)) { importScripts(files[l]); loaded.add(l); } });
};
const post = m => self.postMessage(m);
const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
let lastTick = 0;
const progress = (text, pct) => { const now = Date.now(); if (now - lastTick > 120 || pct === 100) { lastTick = now; post({ type: 'progress', text, pct }); } };
const MIME = { json: 'application/json', ndjson: 'application/x-ndjson', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml', yaml: 'application/yaml', sql: 'application/sql', md: 'text/markdown', html: 'text/html', css: 'text/css', js: 'text/javascript', txt: 'text/plain', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

/* ---------- output accumulator: keeps big results as Blob parts, never one giant string ---------- */
class Out {
  constructor() { this.parts = []; this.buf = ''; this.size = 0; this.preview = ''; }
  push(s) {
    if (this.preview.length < 65536) this.preview += s.slice(0, 65536 - this.preview.length);
    this.buf += s; this.size += s.length;
    if (this.buf.length > 1 << 20) { this.parts.push(this.buf); this.buf = ''; }
  }
  blob(type) { if (this.buf) this.parts.push(this.buf); this.buf = ''; return new Blob(this.parts, { type }); }
}

/* ---------- streaming readers ---------- */
async function* textChunks(blob) {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield first && value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value; first = false;
  }
}

// Streams a top-level JSON array, parsing one element at a time. Returns false if the file isn't an array.
async function streamJsonArray(blob, onItem) {
  let started = false, depth = 0, inStr = false, esc = false, hasEl = false, pending = '', read = 0, count = 0;
  const total = blob.size;
  for await (const s of textChunks(blob)) {
    let i = 0, elStart = hasEl ? 0 : -1;
    read += s.length;
    if (!started) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i === s.length) continue;
      if (s[i] !== '[') return false;
      started = true; depth = 1; i++;
    }
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) { inStr = true; if (!hasEl && depth === 1) { hasEl = true; elStart = i; } continue; }
      if (depth === 1) {
        if (c === 44 || c === 93) {
          if (hasEl) { let v; try { v = JSON.parse(pending + s.slice(elStart, i)); } catch (e) { throw new Error(`Record ${count + 1} is not valid JSON: ${e.message}`); } onItem(v); pending = ''; hasEl = false; count++; }
          if (c === 93) { progress(`Parsed ${count.toLocaleString()} records`, 100); return true; }
          continue;
        }
        if (c === 32 || c === 10 || c === 13 || c === 9) continue;
        if (!hasEl) { hasEl = true; elStart = i; }
        if (c === 123 || c === 91) depth++;
      } else if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) depth--;
    }
    if (hasEl) pending += s.slice(elStart);
    progress(`Reading ${fmtBytes(read)} of ${fmtBytes(total)} · ${count.toLocaleString()} records`, Math.min(99, read / total * 100));
  }
  if (!started) return false;
  throw new Error(`The JSON ends before the array closes (after ${count.toLocaleString()} records). The file is malformed or was cut off.`);
}

async function streamLines(blob, onLine) {
  let rest = '', read = 0, n = 0;
  for await (const s of textChunks(blob)) {
    read += s.length;
    const lines = (rest + s).split('\n'); rest = lines.pop();
    for (const l of lines) { n++; if (l.trim()) onLine(l, n); }
    progress(`Reading ${fmtBytes(read)} of ${fmtBytes(blob.size)}`, Math.min(99, read / blob.size * 100));
  }
  if (rest.trim()) onLine(rest, n + 1);
}

/* ---------- table model ---------- */
class Table {
  constructor(opts = {}) { this.cols = new Map(); this.rows = []; this.expandArrays = !!opts.expandArrays; }
  get columns() { return [...this.cols.keys()]; }
  col(k) { let i = this.cols.get(k); if (i === undefined) { i = this.cols.size; this.cols.set(k, i); } return i; }
  addObject(o) {
    const row = [];
    if (o === null || typeof o !== 'object') row[this.col('value')] = o;
    else this.flat(o, '', row);
    this.rows.push(row);
  }
  flat(v, p, row) {
    if (v instanceof Date) { row[this.col(p || 'value')] = v.toISOString(); return; }
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v) && !this.expandArrays) { row[this.col(p || 'value')] = JSON.stringify(v); return; }
      const keys = Object.keys(v);
      if (!keys.length) { row[this.col(p || 'value')] = ''; return; }
      for (const k of keys) this.flat(v[k], p ? p + '.' + k : k, row);
      return;
    }
    row[this.col(p || 'value')] = v;
  }
  setHeader(h) {
    const seen = new Map();
    h.forEach((name, i) => {
      let n = name == null || String(name).trim() === '' ? `column_${i + 1}` : String(name).trim();
      if (seen.has(n)) { const c = seen.get(n) + 1; seen.set(n, c); n = `${n}_${c}`; } else seen.set(n, 1);
      this.cols.set(n, i);
    });
  }
}

const NUM = /^-?(0|[1-9]\d{0,14})(\.\d+)?([eE][+-]?\d+)?$/;
const infer = v => {
  if (typeof v !== 'string') return v;
  if (v === '') return null;
  if (NUM.test(v)) return Number(v);
  const l = v.toLowerCase();
  if (l === 'true') return true; if (l === 'false') return false; if (l === 'null') return null;
  return v;
};

function setPath(obj, key, val, unflatten) {
  if (!unflatten || !key.includes('.')) { obj[key] = val; return; }
  const parts = key.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] === undefined) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    else if (typeof o[k] !== 'object' || o[k] === null) { obj[key] = val; return; }
    o = o[k];
  }
  o[parts[parts.length - 1]] = val;
}

function* tableObjects(t, opts) {
  const cols = t.columns, typed = t.fromText && opts.inferTypes;
  for (const r of t.rows) {
    const o = {};
    for (let i = 0; i < cols.length; i++) {
      let v = r[i]; if (v === undefined) v = null;
      if (typed) v = infer(v);
      if (typeof v === 'string' && opts.parseJsonCells && /^[[{]/.test(v)) { try { v = JSON.parse(v); } catch {} }
      setPath(o, cols[i], v, opts.unflatten);
    }
    yield o;
  }
}

function getPath(v, path) { return path.split('.').filter(Boolean).reduce((o, k) => o == null ? o : o[k], v); }
function findRecords(tree, path) {
  if (path) { const v = getPath(tree, path); if (v === undefined) throw new Error(`Nothing found at records path "${path}".`); return Array.isArray(v) ? v : [v]; }
  if (Array.isArray(tree)) return tree;
  let best = null;
  const walk = (v, d) => {
    if (d > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object' && (!best || v.length > best.length)) best = v; v.slice(0, 50).forEach(x => walk(x, d + 1)); }
    else Object.values(v).forEach(x => walk(x, d + 1));
  };
  walk(tree, 0);
  return best || [tree];
}

/* ---------- parsers ---------- */
function parseCsv(blob, opts, delimiter) {
  need('papa');
  return new Promise((resolve, reject) => {
    const t = new Table(); t.fromText = true; let header = !opts.noHeader, done = 0;
    Papa.parse(blob, {
      delimiter: delimiter || '', skipEmptyLines: 'greedy', chunkSize: 4 * 1024 * 1024,
      chunk: res => {
        let rows = res.data;
        if (header) { t.setHeader(rows[0]); rows = rows.slice(1); header = false; }
        else if (!t.cols.size) { t.setHeader(rows[0].map((_, i) => `column_${i + 1}`)); }
        for (const r of rows) { if (r.length > t.cols.size) for (let i = t.cols.size; i < r.length; i++) t.cols.set(`column_${i + 1}`, i); t.rows.push(r); }
        done = res.meta.cursor;
        progress(`Reading ${fmtBytes(done)} of ${fmtBytes(blob.size)} · ${t.rows.length.toLocaleString()} rows`, Math.min(99, done / blob.size * 100));
      },
      complete: () => resolve(t), error: e => reject(new Error('CSV: ' + e.message))
    });
  });
}

async function parseXlsx(blob, opts) {
  need('xlsx');
  progress('Opening workbook…', 5);
  const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', dense: true, cellDates: true });
  const want = (opts.sheet || '').trim();
  let name = wb.SheetNames[0];
  if (want) name = /^\d+$/.test(want) ? wb.SheetNames[+want - 1] : wb.SheetNames.find(n => n.toLowerCase() === want.toLowerCase());
  if (!name) throw new Error(`Sheet "${want}" not found. Sheets: ${wb.SheetNames.join(', ')}`);
  progress(`Reading sheet "${name}"…`, 40);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
  const t = new Table();
  if (!aoa.length) return { table: t, sheets: wb.SheetNames, sheet: name };
  if (opts.noHeader) t.setHeader(aoa[0].map((_, i) => `column_${i + 1}`)); else t.setHeader(aoa.shift());
  const w = Math.max(t.cols.size, ...aoa.slice(0, 1000).map(r => r.length));
  for (let i = t.cols.size; i < w; i++) t.cols.set(`column_${i + 1}`, i);
  t.rows = aoa.map(r => r.map(v => v instanceof Date ? v.toISOString() : v));
  return { table: t, sheets: wb.SheetNames, sheet: name };
}

function parseXml(text, opts) {
  need('fxp');
  progress('Validating XML…', 20);
  const v = fxp.XMLValidator.validate(text);
  if (v !== true) throw new Error(`XML error on line ${v.err.line}: ${v.err.msg}`);
  progress('Parsing XML…', 50);
  return new fxp.XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', parseTagValue: opts.inferTypes, parseAttributeValue: opts.inferTypes, trimValues: true, ignoreDeclaration: true, ignorePiTags: true, commentPropName: false }).parse(text);
}

/* ---------- writers ---------- */
const cell = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
function writeDelimited(t, d, opts, out) {
  const q = s => (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  if (opts.bom && d === ',') out.push('\uFEFF');
  out.push(t.columns.map(c => q(c)).join(d) + '\r\n');
  const n = t.cols.size, total = t.rows.length;
  t.rows.forEach((r, idx) => {
    let line = ''; for (let i = 0; i < n; i++) line += (i ? d : '') + q(cell(r[i]));
    out.push(line + '\r\n');
    if (idx % 5000 === 0) progress(`Writing row ${idx.toLocaleString()} of ${total.toLocaleString()}`, idx / total * 100);
  });
}

function writeXlsx(t, opts) {
  need('xlsx');
  const MAX = 1048575, cols = t.columns, wb = XLSX.utils.book_new(); let truncated = 0;
  const typed = t.fromText && opts.inferTypes;
  const conv = v => { if (typed) v = infer(v); if (v == null) return null; if (typeof v === 'object') v = JSON.stringify(v); if (typeof v === 'string' && v.length > 32767) { truncated++; return v.slice(0, 32767); } return v; };
  const sheets = Math.max(1, Math.ceil(t.rows.length / MAX));
  for (let s = 0; s < sheets; s++) {
    progress(`Building sheet ${s + 1} of ${sheets}…`, 10 + s / sheets * 60);
    const chunk = t.rows.slice(s * MAX, (s + 1) * MAX).map(r => { const a = new Array(cols.length); for (let i = 0; i < cols.length; i++) a[i] = conv(r[i]); return a; });
    const ws = XLSX.utils.aoa_to_sheet([cols, ...chunk], { dense: true });
    ws['!cols'] = cols.map(c => ({ wch: Math.min(48, Math.max(10, String(c).length + 2)) }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: chunk.length, c: Math.max(0, cols.length - 1) } }) };
    const base = (opts.sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 28);
    XLSX.utils.book_append_sheet(wb, ws, sheets > 1 ? `${base}_${s + 1}` : base);
  }
  progress('Compressing workbook…', 80);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return { blob: new Blob([buf], { type: MIME.xlsx }), notes: [sheets > 1 ? `Split across ${sheets} sheets (Excel allows 1,048,576 rows per sheet).` : '', truncated ? `${truncated} cells were cut to Excel's 32,767 character limit.` : ''].filter(Boolean) };
}

function sqlType(vals) {
  let t = null;
  for (const v of vals) { if (v == null || v === '') continue; const k = typeof v === 'boolean' ? 'BOOLEAN' : typeof v === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : 'TEXT'; if (!t) t = k; else if (t !== k) t = (t === 'INTEGER' && k === 'REAL') || (t === 'REAL' && k === 'INTEGER') ? 'REAL' : 'TEXT'; }
  return t || 'TEXT';
}
function writeSql(t, opts, out) {
  const name = opts.tableName || 'data', id = s => '"' + String(s).replace(/"/g, '""') + '"';
  const typed = t.fromText && opts.inferTypes, cols = t.columns;
  const lit = v => { if (typed) v = infer(v); if (v == null) return 'NULL'; if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL'; if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; return "'" + cell(v).replace(/'/g, "''") + "'"; };
  if (opts.createTable) {
    const sample = t.rows.slice(0, 2000);
    out.push(`CREATE TABLE ${id(name)} (\n${cols.map((c, i) => `  ${id(c)} ${sqlType(sample.map(r => typed ? infer(r[i]) : r[i]))}`).join(',\n')}\n);\n\n`);
  }
  const head = `INSERT INTO ${id(name)} (${cols.map(id).join(', ')}) VALUES\n`;
  for (let i = 0; i < t.rows.length; i += 500) {
    out.push(head + t.rows.slice(i, i + 500).map(r => '  (' + cols.map((_, j) => lit(r[j])).join(', ') + ')').join(',\n') + ';\n');
    progress(`Writing row ${i.toLocaleString()} of ${t.rows.length.toLocaleString()}`, i / t.rows.length * 100);
  }
}
function writeMd(t, out) {
  const e = s => cell(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  out.push('| ' + t.columns.map(e).join(' | ') + ' |\n| ' + t.columns.map(() => '---').join(' | ') + ' |\n');
  for (const r of t.rows) out.push('| ' + t.columns.map((_, i) => e(r[i])).join(' | ') + ' |\n');
}

const xmlName = k => { let n = String(k).replace(/[^A-Za-z0-9_.\-@#]/g, '_'); if (!/^[A-Za-z_@#]/.test(n)) n = '_' + n; return n; };
const xmlKeys = v => Array.isArray(v) ? v.map(xmlKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [xmlName(k), xmlKeys(x)])) : v;

function writeTree(to, src, opts, out) {
  // src: { value } or { items: iterable, count }
  const ind = opts.indent === 'min' ? 0 : opts.indent === 'tab' ? '\t' : +opts.indent || 2;
  const items = src.items || (Array.isArray(src.value) ? src.value : null), count = src.count ?? items?.length ?? 1;
  let n = 0;
  const tick = () => { if (++n % 2000 === 0) progress(`Writing record ${n.toLocaleString()} of ${count.toLocaleString()}`, n / count * 100); };
  if (to === 'json') {
    if (!items) { out.push(JSON.stringify(src.value, null, ind) + '\n'); return; }
    const pad = ind ? (typeof ind === 'string' ? ind : ' '.repeat(ind)) : '';
    out.push('['); let first = true;
    for (const it of items) { out.push((first ? '' : ',') + (ind ? '\n' + pad + JSON.stringify(it, null, ind).replace(/\n/g, '\n' + pad) : JSON.stringify(it))); first = false; tick(); }
    out.push(ind ? '\n]\n' : ']');
  } else if (to === 'ndjson') {
    for (const it of items || [src.value]) { out.push(JSON.stringify(it) + '\n'); tick(); }
  } else if (to === 'yaml') {
    need('yaml');
    if (!items) { out.push(jsyaml.dump(src.value, { indent: +opts.indent || 2, lineWidth: -1, noRefs: true })); return; }
    for (const it of items) { out.push(jsyaml.dump([it], { indent: +opts.indent || 2, lineWidth: -1, noRefs: true })); tick(); }
  } else if (to === 'xml') {
    need('fxp');
    const b = new fxp.XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', format: ind !== 0, indentBy: typeof ind === 'string' ? ind : ' '.repeat(ind || 2), suppressEmptyNode: true });
    out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    const root = xmlName(opts.xmlRoot || 'root'), rowName = xmlName(opts.xmlRow || 'row');
    if (!items) {
      const v = xmlKeys(src.value);
      out.push(v && typeof v === 'object' && Object.keys(v).length === 1 ? b.build(v) : b.build({ [root]: v }));
      return;
    }
    const pad = ind === 0 ? '' : typeof ind === 'string' ? ind : ' '.repeat(ind || 2);
    out.push(`<${root}>` + (ind === 0 ? '' : '\n'));
    for (const it of items) {
      const x = b.build({ [rowName]: xmlKeys(it && typeof it === 'object' ? it : { value: it }) });
      out.push(ind === 0 ? x : x.replace(/^(?=.)/gm, pad)); tick();
    }
    out.push(`</${root}>\n`);
  }
}

/* ---------- convert pipeline ---------- */
const TABULAR = new Set(['csv', 'tsv', 'xlsx', 'sql', 'md']);
async function convert(job) {
  const t0 = performance.now(), { from, to, opts } = job, src = job.source;
  let table = null, tree, items = null, meta = {};
  const wantTable = TABULAR.has(to);

  if (from === 'json' && opts.recordsPath) {
    progress('Parsing JSON…', 30); tree = JSON.parse((await src.text()).replace(/^\uFEFF/, ''));
  } else if (from === 'json') {
    if (wantTable) { table = new Table(opts); const ok = await streamJsonArray(src, o => table.addObject(o)); if (!ok) { progress('Parsing JSON…', 30); tree = JSON.parse((await src.text()).replace(/^\uFEFF/, '')); } }
    else { items = []; const ok = await streamJsonArray(src, o => items.push(o)); if (!ok) { progress('Parsing JSON…', 30); tree = JSON.parse((await src.text()).replace(/^\uFEFF/, '')); items = null; } }
  } else if (from === 'ndjson') {
    const sink = wantTable ? (table = new Table(opts), o => table.addObject(o)) : (items = [], o => items.push(o));
    await streamLines(src, (l, n) => { try { sink(JSON.parse(l)); } catch { throw new Error(`Line ${n} is not valid JSON.`); } });
  } else if (from === 'csv' || from === 'tsv') {
    table = await parseCsv(src, opts, from === 'tsv' ? '\t' : opts.delimiter === 'tab' ? '\t' : opts.delimiter);
  } else if (from === 'xlsx') {
    const r = await parseXlsx(src, opts); table = r.table; meta.sheets = r.sheets; meta.sheet = r.sheet;
  } else if (from === 'xml') {
    tree = parseXml(await src.text(), opts);
  } else if (from === 'yaml') {
    need('yaml'); progress('Parsing YAML…', 30);
    const docs = jsyaml.loadAll(await src.text()); tree = docs.length === 1 ? docs[0] : docs;
  } else throw new Error('Unsupported input format: ' + from);

  if (tree !== undefined && (wantTable || opts.recordsPath)) {
    const recs = findRecords(tree, opts.recordsPath);
    if (wantTable) { table = new Table(opts); recs.forEach(r => table.addObject(r)); tree = undefined; }
    else tree = recs;
  }
  if (items && !wantTable) tree = items;

  const out = new Out(); let blob, notes = [];
  const rows = table ? table.rows.length : Array.isArray(tree) ? tree.length : 1;
  if (to === 'xlsx') { const r = writeXlsx(table, opts); blob = r.blob; notes = r.notes; }
  else {
    if (to === 'csv') writeDelimited(table, opts.outDelimiter === 'semicolon' ? ';' : ',', opts, out);
    else if (to === 'tsv') writeDelimited(table, '\t', opts, out);
    else if (to === 'sql') writeSql(table, opts, out);
    else if (to === 'md') writeMd(table, out);
    else if (table) writeTree(to, { items: tableObjects(table, opts), count: table.rows.length }, opts, out);
    else writeTree(to, { value: tree }, opts, out);
    blob = out.blob(MIME[to] + ';charset=utf-8');
  }
  progress('Done', 100);
  const res = { type: 'done', blob, rows, columns: table ? table.cols.size : null, ms: Math.round(performance.now() - t0), notes, meta, textPreview: to === 'xlsx' ? '' : out.preview, truncated: out.size > out.preview.length };
  if (table) res.tablePreview = { columns: table.columns, rows: table.rows.slice(0, 100).map(r => table.columns.map((_, i) => cell(r[i]))) };
  return res;
}

/* ---------- formatters ---------- */
function formatXml(xml, pad, minify) {
  const toks = xml.replace(/>\s+</g, '><').trim().match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]+>|[^<]+/g) || [];
  if (minify) return toks.filter(t => !t.startsWith('<!--')).map(t => t.startsWith('<') ? t : t.trim()).join('');
  const out = []; let d = 0; const p = () => pad.repeat(Math.max(0, d));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('</')) { d--; out.push(p() + t); }
    else if (t.startsWith('<') && !/^<[?!]/.test(t) && !t.endsWith('/>')) {
      const a = toks[i + 1], b = toks[i + 2];
      if (a && !a.startsWith('<') && b && b.startsWith('</')) { out.push(p() + t + a.trim() + b); i += 2; }
      else if (a && a.startsWith('</')) { out.push(p() + t + a); i++; }
      else { out.push(p() + t); d++; }
    } else if (!t.startsWith('<')) { if (t.trim()) out.push(p() + t.trim()); }
    else out.push(p() + t);
  }
  return out.join('\n') + '\n';
}
const minifyCss = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>~+])\s*/g, '$1').replace(/;}/g, '}').trim();

async function format(job) {
  const t0 = performance.now(), text = job.text ?? await job.source.text(), { lang, action } = job;
  const pad = job.indent === 'tab' ? '\t' : ' '.repeat(+job.indent || 2), size = job.indent === 'tab' ? 1 : +job.indent || 2;
  progress('Formatting…', 30);
  let r;
  const bOpts = { indent_size: size, indent_char: pad[0], indent_with_tabs: job.indent === 'tab', preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: true };
  switch (lang) {
    case 'json': {
      let v; try { v = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { const m = /position (\d+)/.exec(e.message); if (m) { const ln = text.slice(0, +m[1]).split('\n').length; throw new Error(`${e.message} (line ${ln})`); } throw e; }
      if (job.sortKeys) { const s = x => Array.isArray(x) ? x.map(s) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, s(x[k])])) : x; v = s(v); }
      r = action === 'minify' ? JSON.stringify(v) : JSON.stringify(v, null, job.indent === 'tab' ? '\t' : size) + '\n'; break;
    }
    case 'html': need('beautify'); r = beautifier.html(text, { ...bOpts, wrap_line_length: 0, indent_inner_html: true, extra_liners: [] }); break;
    case 'css': need('beautify'); r = action === 'minify' ? minifyCss(text) : beautifier.css(text, bOpts); break;
    case 'js': need('beautify'); r = beautifier.js(text, { ...bOpts, space_in_empty_paren: false, e4x: true, brace_style: 'collapse' }); break;
    case 'xml': r = formatXml(text, pad, action === 'minify'); break;
    case 'sql': need('sql'); r = sqlFormatter.format(text, { language: job.dialect || 'sql', tabWidth: size, useTabs: job.indent === 'tab', keywordCase: 'upper' }) + '\n'; break;
    case 'yaml': need('yaml'); { const docs = jsyaml.loadAll(text); r = docs.map(d => jsyaml.dump(d, { indent: size, lineWidth: -1, noRefs: true, sortKeys: !!job.sortKeys })).join('---\n'); } break;
    default: throw new Error('Unknown language ' + lang);
  }
  const blob = new Blob([r], { type: (MIME[lang] || 'text/plain') + ';charset=utf-8' });
  return { type: 'done', blob, text: r.length <= 1.5e6 ? r : null, preview: r.slice(0, 100000), inSize: text.length, outSize: r.length, ms: Math.round(performance.now() - t0) };
}

self.onmessage = async ({ data: job }) => {
  try { post(job.kind === 'format' ? await format(job) : await convert(job)); }
  catch (e) { post({ type: 'error', message: e && e.message ? e.message : String(e) }); }
};
