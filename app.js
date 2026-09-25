/* DevHub — developer toolkit PWA
 * Developer tools run entirely in the browser. Tasks, links and preferences belong to a signed-in
 * user: they are cached on the device (so the app works offline) and synced through server.js,
 * which stores each user's JSON files separately in a private GitHub repo.
 */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const dayKey = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
  const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d); };
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  const b64encUtf8 = str => {
    const bytes = new TextEncoder().encode(str); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64decUtf8 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
  let toastTimer;
  const toast = (msg, action) => {
    const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    if (action) $('button', t).onclick = () => { t.classList.remove('show'); action.fn(); };
    t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2400);
  };
  const copy = async text => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed — select and copy manually'); } };

  // ---------- config, session & API ----------
  const CONFIG = window.DEVHUB_CONFIG || {};
  const API = String(CONFIG.apiBase || '').replace(/\/$/, '');
  const raw = { get: k => { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } } };
  const session = {
    token: raw.get('devhub:token'),
    user: store.get('devhub:user', null) || (() => { try { return JSON.parse(sessionStorage.getItem('devhub:user')); } catch { return null; } })(),
    save(token, user, remember = true) {
      this.token = token; this.user = user;
      try { const s = remember ? localStorage : sessionStorage; s.setItem('devhub:token', token); s.setItem('devhub:user', JSON.stringify(user)); (remember ? sessionStorage : localStorage).removeItem('devhub:token'); } catch {}
    },
    setUser(user) { this.user = user; try { (localStorage.getItem('devhub:token') ? localStorage : sessionStorage).setItem('devhub:user', JSON.stringify(user)); } catch {} },
    clear() { this.token = null; this.user = null; try { ['devhub:token', 'devhub:user'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); }); } catch {} }
  };
  let serverConfig = { registration: 'open' };

  async function api(path, { method = 'GET', body } = {}) {
    let r;
    try {
      r = await fetch(API + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch { const e = new Error('Can’t reach the server. Check your connection.'); e.offline = true; throw e; }
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error(j.error || `Request failed (${r.status})`); e.status = r.status; e.body = j;
      if (r.status === 401 && session.token && !path.startsWith('/auth/login')) sessionExpired();
      throw e;
    }
    return j;
  }

  // ---------- per-user data: cached on the device, synced to the server ----------
  const DOCS = ['tasks', 'links', 'prefs'];
  const data = {
    docs: {}, ver: {}, dirty: {}, listeners: new Set(),
    key(k) { return `devhub:u:${session.user.id}:${k}`; },
    load() { this.docs = {}; DOCS.forEach(d => this.docs[d] = store.get(this.key(d), null)); this.ver = store.get(this.key('ver'), {}); this.dirty = store.get(this.key('dirty'), {}); },
    persist() { DOCS.forEach(d => store.set(this.key(d), this.docs[d])); store.set(this.key('ver'), this.ver); store.set(this.key('dirty'), this.dirty); },
    get(name) { return this.docs[name]; },
    set(name, value) { this.docs[name] = value; this.dirty[name] = true; this.persist(); schedulePush(); },
    hasUnsynced() { return DOCS.some(d => this.dirty[d]); },
    wipe(uidToWipe) { ['tasks', 'links', 'prefs', 'ver', 'dirty'].forEach(k => store.del(`devhub:u:${uidToWipe}:${k}`)); },
    changed() { this.listeners.forEach(fn => fn()); }
  };

  // Merge two copies of a document edited on different devices: newest version of each item wins.
  function mergeById(a = [], b = []) {
    const m = new Map();
    for (const x of b) m.set(x.id, x);
    for (const x of a) { const y = m.get(x.id); if (!y || String(x.updatedAt || '') >= String(y.updatedAt || '')) m.set(x.id, x); }
    return [...m.values()];
  }
  function mergeDoc(name, local, remote) {
    if (remote == null) return local; if (local == null) return remote;
    if (name === 'links' && Array.isArray(local) && Array.isArray(remote)) return mergeById(local, remote);
    if (name === 'tasks' && local.tasks && remote.tasks) return { ...remote, ...local, tasks: mergeById(local.tasks, remote.tasks), projects: mergeById(local.projects, remote.projects) };
    return local;
  }

  const setStatus = (text, cls = '') => {
    const el = $('#syncStatus'); if (el) { el.textContent = text; el.className = 'sync ' + cls; }
    document.querySelectorAll('.mobile-sync').forEach(m => m.textContent = text);
  };
  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function pull() {
    if (!session.user) return;
    setStatus('Syncing…', 'busy');
    try {
      let changed = false;
      for (const name of DOCS) {
        const r = await api('/data/' + name);
        if (r.data == null && name === 'links' && data.docs.links == null) { // first sign-in: start with the default tool store list
          try { data.docs.links = await fetch('seed/links.json').then(x => x.json()); data.dirty.links = true; changed = true; } catch {}
          continue;
        }
        if (data.dirty[name]) { if (r.version !== data.ver[name]) { data.docs[name] = mergeDoc(name, data.docs[name], r.data); data.ver[name] = r.version; changed = true; } }
        else if (r.version !== data.ver[name]) { data.docs[name] = r.data; data.ver[name] = r.version; changed = true; }
      }
      data.persist();
      if (changed) data.changed();
      setStatus(`Synced ${stamp()}`, 'ok');
      if (data.hasUnsynced()) await push();
    } catch (e) { setStatus(e.offline ? 'Offline — changes saved on this device' : 'Sync paused — ' + e.message, e.offline ? '' : 'err'); }
  }

  let pushing = false, pushTimer;
  async function push() {
    if (!session.user || pushing) return;
    pushing = true; setStatus('Saving…', 'busy');
    try {
      for (const name of DOCS) {
        if (!data.dirty[name]) continue;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await api('/data/' + name, { method: 'PUT', body: { data: data.docs[name], baseVersion: data.ver[name] || 0 } });
            data.ver[name] = r.version; data.dirty[name] = false; break;
          } catch (e) {
            if (e.status !== 409) throw e;
            data.docs[name] = mergeDoc(name, data.docs[name], e.body.data); data.ver[name] = e.body.version; data.changed();
          }
        }
      }
      data.persist();
      setStatus(`Saved ${stamp()}`, 'ok');
    } catch (e) { setStatus(e.offline ? 'Offline — changes saved on this device' : 'Not saved — ' + e.message, e.offline ? '' : 'err'); }
    finally { pushing = false; }
  }
  function schedulePush() { setStatus('Unsaved changes…', 'busy'); clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }

  function startSession(token, user, remember) {
    session.save(token, user, remember);
    data.load(); renderNavUser(); pull();
  }
  function sessionExpired() {
    const had = session.user; session.clear(); renderNavUser();
    if (had) { toast('Your session ended. Sign in again.'); location.hash = 'login'; }
  }
  async function signOut() {
    if (data.hasUnsynced()) { await push(); if (data.hasUnsynced() && !confirm('Some changes haven’t reached the server yet and will be lost. Sign out anyway?')) return; }
    const id = session.user.id; data.wipe(id); session.clear(); renderNavUser(); location.hash = 'login'; toast('Signed out');
  }
  function renderNavUser() {
    const el = $('#navUser'); if (!el) return;
    const u = session.user;
    el.innerHTML = u ? `<a href="#account" class="user-chip" data-route="account"><span class="avatar" aria-hidden="true">${esc((u.name || u.username).trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase())}</span><span class="uc-text"><b>${esc(u.name || u.username)}</b><span class="sync" id="syncStatus">Synced</span></span></a>`
      : `<a href="#login" class="user-chip signin" data-route="login">Sign in</a>`;
    const acc = $('.nav a[data-route="account"].nav-link'); if (acc) acc.textContent = u ? 'Account' : 'Sign in';
  }

  // ---------- developer tools ----------
  const io = (el, { inLabel = 'Input', outLabel = 'Output', placeholder = '', actions, sample = '' }) => {
    el.innerHTML = `
      <div class="grid2">
        <div><label for="tin">${inLabel}</label><textarea id="tin" spellcheck="false" placeholder="${esc(placeholder)}">${esc(sample)}</textarea></div>
        <div><label>${outLabel}</label><div class="out" id="tout"></div></div>
      </div>
      <div class="row" style="margin-top:12px">
        ${actions.map((a, i) => `<button data-a="${i}" class="${i === 0 ? 'primary' : ''}">${a.label}</button>`).join('')}
        <button data-copy class="ghost">Copy output</button>
      </div>`;
    const out = $('#tout', el), tin = $('#tin', el);
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      out.classList.remove('err');
      try { const r = await actions[b.dataset.a].fn(tin.value); if (r && r.html !== undefined) out.innerHTML = r.html; else out.textContent = r; }
      catch (e) { out.classList.add('err'); out.textContent = e.message; }
    });
    $('[data-copy]', el).onclick = () => copy(out.textContent);
  };

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const words = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').trim().toLowerCase().split(' ').filter(Boolean);
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1);

  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n'), n = A.length, m = B.length;
    if (n * m > 4e6) throw new Error('Texts are too large to compare here (over ~2000×2000 lines).');
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push('  ' + esc(A[i])); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`<span class="diff-del">- ${esc(A[i++])}</span>`);
      else out.push(`<span class="diff-add">+ ${esc(B[j++])}</span>`);
    }
    while (i < n) out.push(`<span class="diff-del">- ${esc(A[i++])}</span>`);
    while (j < m) out.push(`<span class="diff-add">+ ${esc(B[j++])}</span>`);
    return out.join('\n');
  }

  // ---------- file helpers (desktop, tablet, phone, Android app) ----------
  const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const coarse = matchMedia('(pointer: coarse)').matches;
  let activeWorker = null;
  function runJob(job, onProgress) {
    return new Promise((resolve, reject) => {
      const w = new Worker('worker.js'); activeWorker = w;
      w.onmessage = ({ data: m }) => {
        if (m.type === 'progress') return onProgress && onProgress(m);
        w.terminate(); activeWorker = null;
        m.type === 'done' ? resolve(m) : reject(new Error(m.message));
      };
      w.onerror = e => { w.terminate(); activeWorker = null; reject(new Error(e.message || 'The background worker stopped. The file may be too large for this device’s memory.')); };
      w.postMessage(job);
    });
  }
  function cancelJob() { if (activeWorker) { activeWorker.terminate(); activeWorker = null; return true; } return false; }

  async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function saveBlob(blob, name) {
    if (isNative() && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) { // Android app: write in chunks to app storage, then open the share sheet to save anywhere
      const { Filesystem, Share } = window.Capacitor.Plugins;
      const CH = 3 * 1024 * 1024;
      for (let i = 0; i < blob.size || i === 0; i += CH) {
        const data = await blobToBase64(blob.slice(i, i + CH));
        await (i === 0 ? Filesystem.writeFile : Filesystem.appendFile)({ path: name, data, directory: 'CACHE' });
        if (blob.size === 0) break;
      }
      const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
      await Share.share({ title: name, files: [uri], dialogTitle: 'Save or send ' + name });
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('Downloaded ' + name);
  }
  const canShareFiles = () => { try { return !isNative() && navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }); } catch { return false; } };
  async function shareBlob(blob, name) {
    try { await navigator.share({ files: [new File([blob], name, { type: blob.type.split(';')[0] })], title: name }); }
    catch (e) { if (e.name !== 'AbortError') toast('Sharing isn’t available for this file here — use Download'); }
  }

  const EXT = { json: 'json', geojson: 'json', ndjson: 'ndjson', jsonl: 'ndjson', csv: 'csv', tsv: 'tsv', tab: 'tsv', xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xlsx', ods: 'xlsx', xml: 'xml', yaml: 'yaml', yml: 'yaml', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css', js: 'js', mjs: 'js', cjs: 'js', ts: 'js', jsx: 'js', tsx: 'js', sql: 'sql', svg: 'xml' };
  const extOf = name => (name.split('.').pop() || '').toLowerCase();
  async function sniff(blob) {
    const head = (await blob.slice(0, 2048).text()).replace(/^\uFEFF/, '').trimStart();
    if (/^[\[{]/.test(head)) { const lines = head.split('\n').filter(l => l.trim()); return lines.length > 1 && lines.every(l => /^\s*\{.*\}\s*,?\s*$/.test(l)) && !/^\[/.test(head) ? 'ndjson' : 'json'; }
    if (head.startsWith('<')) return 'xml';
    if (/^(---|[\w"'-]+:\s)/.test(head)) return 'yaml';
    return head.split('\n')[0].includes('\t') ? 'tsv' : 'csv';
  }

  // Drop zone + file picker + paste fallback. Calls onFile({blob, name, size}) or clears on paste.
  function fileSource(el, { accept, onFile, pasteLabel = 'Paste text instead', pasteArea }) {
    el.innerHTML = `<div class="drop" tabindex="0" role="group" aria-label="Choose a file">
        <p class="drop-title">Choose a file${coarse ? '' : ' or drop it here'}</p>
        <p class="hint">Files stay on your device. Large files are processed in the background.</p>
        <div class="row" style="justify-content:center"><label class="btn primary">Choose file<input type="file" hidden ${coarse ? '' : `accept="${accept}"`}></label>${pasteArea ? `<button type="button" data-paste-toggle>${pasteLabel}</button>` : ''}</div>
        <div class="file-chip" hidden></div></div>`;
    const drop = $('.drop', el), input = $('input', el), chip = $('.file-chip', el);
    const take = f => { if (!f) return; chip.hidden = false; chip.innerHTML = `<span><b>${esc(f.name)}</b> · ${fmtBytes(f.size)}</span><button type="button" class="ghost" data-clear aria-label="Remove file">✕</button>`;
      $('[data-clear]', chip).onclick = () => { chip.hidden = true; input.value = ''; onFile(null); }; onFile({ blob: f, name: f.name, size: f.size }); };
    input.onchange = () => take(input.files[0]);
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => take(e.dataTransfer.files[0]));
    const pb = $("[data-paste-toggle]", el);
    if (pb) pb.onclick = () => { pasteArea.hidden = !pasteArea.hidden; pb.textContent = pasteArea.hidden ? pasteLabel : 'Hide text box'; if (!pasteArea.hidden) pasteArea.focus(); };
    return { clear: () => { chip.hidden = true; input.value = ''; } };
  }

  function progressUI(el) {
    el.innerHTML = `<div class="progress"><span style="width:0"></span></div><div class="row" style="justify-content:space-between"><span class="hint" data-t>Starting…</span><button type="button" class="ghost danger" data-cancel>Cancel</button></div>`;
    el.hidden = false;
    $('[data-cancel]', el).onclick = () => { if (cancelJob()) { el.hidden = true; toast('Cancelled'); el.dispatchEvent(new Event('cancel')); } };
    return m => { $('span', el).style.width = (m.pct || 0) + '%'; $('[data-t]', el).textContent = m.text; };
  }

  // ---------- formatter tools ----------
  const FMT = {
    json: { name: 'JSON', minify: true, sort: true, accept: '.json,application/json', sample: '{"name":"devhub","version":2,"features":["formatters","converters"],"offline":true,"limits":{"rows":null}}' },
    html: { name: 'HTML', accept: '.html,.htm,text/html', sample: '<!doctype html><html><head><title>Demo</title></head><body><div class="card"><h1>Hello</h1><p>Some <b>bold</b> text</p><ul><li>One</li><li>Two</li></ul></div></body></html>' },
    css: { name: 'CSS', minify: true, accept: '.css,.scss,.less,text/css', sample: '.card{display:flex;gap:8px;padding:16px}.card h1{font-size:2rem;margin:0}@media (max-width:600px){.card{flex-direction:column}}' },
    js: { name: 'JavaScript', accept: '.js,.mjs,.cjs,.ts,.jsx,.tsx', sample: 'const sum=(a,b)=>{return a+b};async function load(url){const r=await fetch(url);if(!r.ok){throw new Error(r.status)}return r.json()}export default {sum,load}' },
    xml: { name: 'XML', minify: true, accept: '.xml,.svg,application/xml,text/xml', sample: '<?xml version="1.0"?><catalog><book id="b1"><title>Clean Code</title><price>32.5</price></book><book id="b2"><title>Refactoring</title><price>41</price></book></catalog>' },
    sql: { name: 'SQL', dialect: true, accept: '.sql', sample: "select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.active = true and o.created_at > '2026-01-01' group by u.id, u.name order by orders desc limit 20;" },
    yaml: { name: 'YAML', sort: true, accept: '.yaml,.yml', sample: 'services:\n    web: {image: "nginx:1.27", ports: ["80:80"]}\n    db:\n          image: postgres:16\n          environment: {POSTGRES_PASSWORD: example}' }
  };
  const INLINE_LIMIT = 1.5 * 1024 * 1024;

  function formatterTool(lang) {
    return el => {
      const f = FMT[lang];
      el.innerHTML = `<div data-src></div>
        <div class="row" style="margin:12px 0">
          <label class="inline">Indent <select data-indent><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tabs</option></select></label>
          ${f.dialect ? `<label class="inline">Dialect <select data-dialect>${['sql', 'mysql', 'postgresql', 'sqlite', 'tsql', 'plsql', 'mariadb', 'bigquery', 'snowflake', 'redshift', 'spark'].map(d => `<option>${d}</option>`).join('')}</select></label>` : ''}
          ${f.sort ? `<label class="inline"><input type="checkbox" data-sort> Sort keys</label>` : ''}
        </div>
        <div class="grid2"><div><label for="fin">Input</label><textarea id="fin" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(f.sample)}</textarea></div>
          <div><label for="fout">Output</label><textarea id="fout" spellcheck="false" readonly></textarea></div></div>
        <div class="row action-bar"><button class="primary" data-go="beautify">Format</button>${f.minify ? '<button data-go="minify">Minify</button>' : ''}
          <button data-copy>Copy</button><button data-dl>Download</button>${canShareFiles() ? '<button data-share>Share</button>' : ''}</div>
        <div data-prog hidden></div><p class="hint" data-stat></p>`;
      let file = null, result = null;
      const tin = $('#fin', el), tout = $('#fout', el), stat = $('[data-stat]', el);
      fileSource($('[data-src]', el), { accept: f.accept, onFile: x => {
        file = x; result = null; tout.value = '';
        if (!x) { tin.disabled = false; tin.value = f.sample; return; }
        if (x.size <= INLINE_LIMIT) { x.blob.text().then(t => { tin.value = t; tin.disabled = false; file = null; stat.textContent = ''; }); }
        else { tin.value = `${x.name} is ${fmtBytes(x.size)} — too large to show here. It will be formatted in the background and you can download the result.`; tin.disabled = true; }
      } });
      el.querySelectorAll('[data-go]').forEach(b => b.onclick = async () => {
        const prog = progressUI($('[data-prog]', el)); stat.textContent = ''; tout.classList.remove('err');
        const job = { kind: 'format', lang, action: b.dataset.go, indent: $('[data-indent]', el).value, dialect: $('[data-dialect]', el)?.value, sortKeys: $('[data-sort]', el)?.checked };
        if (file) job.source = file.blob; else job.text = tin.value;
        try {
          result = await runJob(job, prog);
          tout.value = result.text ?? result.preview + `\n\n… output is ${fmtBytes(result.outSize)}; showing the first 100 KB. Use Download for the full file.`;
          const saved = result.inSize - result.outSize;
          stat.textContent = `${fmtBytes(result.inSize)} → ${fmtBytes(result.outSize)}${b.dataset.go === 'minify' && saved > 0 ? ` (${Math.round(saved / result.inSize * 100)}% smaller)` : ''} in ${result.ms} ms`;
        } catch (e) { result = null; tout.value = e.message; tout.classList.add('err'); }
        $('[data-prog]', el).hidden = true;
      });
      const outName = () => (file ? file.name.replace(/\.[^.]+$/, '') : 'formatted') + '.' + (lang === 'js' ? 'js' : lang);
      $('[data-copy]', el).onclick = () => result?.text != null ? copy(result.text) : result ? toast('Too large to copy — use Download') : toast('Format something first');
      $('[data-dl]', el).onclick = () => result ? saveBlob(result.blob, outName()).catch(e => toast(e.message)) : toast('Format something first');
      const sh = $('[data-share]', el); if (sh) sh.onclick = () => result ? shareBlob(result.blob, outName()) : toast('Format something first');
    };
  }

  // ---------- converter tools ----------
  const IN_FORMATS = { json: 'JSON', ndjson: 'NDJSON / JSON Lines', csv: 'CSV', tsv: 'TSV', xlsx: 'Excel (.xlsx, .xls, .ods)', xml: 'XML', yaml: 'YAML' };
  const OUT_FORMATS = { json: 'JSON', ndjson: 'NDJSON / JSON Lines', csv: 'CSV', tsv: 'TSV', xlsx: 'Excel (.xlsx)', xml: 'XML', yaml: 'YAML', sql: 'SQL inserts', md: 'Markdown table' };
  const OUT_EXT = { json: 'json', ndjson: 'ndjson', csv: 'csv', tsv: 'tsv', xlsx: 'xlsx', xml: 'xml', yaml: 'yaml', sql: 'sql', md: 'md' };
  const SAMPLES = {
    json: '[\n  {"id": 1, "name": "Ada", "role": "admin", "address": {"city": "London", "zip": "N1"}, "tags": ["core", "ops"]},\n  {"id": 2, "name": "Linus", "role": "dev", "address": {"city": "Portland", "zip": "97201"}, "tags": ["kernel"]}\n]',
    ndjson: '{"id":1,"event":"login","ok":true}\n{"id":2,"event":"logout","ok":true}',
    csv: 'id,name,role,address.city\n1,Ada,admin,London\n2,Linus,dev,Portland\n3,"Grace, Rear Admiral",navy,Arlington',
    tsv: 'id\tname\trole\n1\tAda\tadmin\n2\tLinus\tdev',
    xml: '<?xml version="1.0"?>\n<catalog>\n  <book id="b1"><title>Clean Code</title><author>Robert Martin</author><price>32.5</price></book>\n  <book id="b2"><title>Refactoring</title><author>Martin Fowler</author><price>41</price></book>\n</catalog>',
    yaml: '- id: 1\n  name: Ada\n  skills: [math, engines]\n- id: 2\n  name: Linus\n  skills: [c, git]',
    xlsx: ''
  };

  function converterTool(preset) {
    return el => {
      const allowFrom = preset.from || Object.keys(IN_FORMATS), allowTo = preset.to || Object.keys(OUT_FORMATS);
      const sel = (id, list, labels, v) => `<select data-${id}>${list.map(k => `<option value="${k}" ${k === v ? 'selected' : ''}>${labels[k]}</option>`).join('')}</select>`;
      el.innerHTML = `<div data-src></div>
        <textarea data-paste hidden spellcheck="false" autocapitalize="off" placeholder="Paste your data here"></textarea>
        <div class="conv-row"><div><label>From</label>${sel('from', allowFrom, IN_FORMATS, allowFrom[0])}</div>
          <button type="button" class="swap" data-swap aria-label="Swap formats" title="Swap">⇄</button>
          <div><label>To</label>${sel('to', allowTo, OUT_FORMATS, allowTo[0] === allowFrom[0] ? allowTo[1] : allowTo[0])}</div></div>
        <details class="opts"><summary>Options</summary><div class="opt-grid">
          <label data-when="from:csv">Delimiter <select data-o="delimiter"><option value="">Detect automatically</option><option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value="tab">Tab</option><option value="|">Pipe |</option></select></label>
          <label data-when="from:csv,tsv,xlsx" class="check"><input type="checkbox" data-o="noHeader"> First row is data, not headers</label>
          <label data-when="from:xlsx">Sheet (name or number) <input data-o="sheet" placeholder="1"></label>
          <label data-when="from:json,xml,yaml">Records path <input data-o="recordsPath" placeholder="Auto-detect, e.g. catalog.book"></label>
          <label data-when="from:csv,tsv,xml" class="check"><input type="checkbox" data-o="inferTypes" checked> Detect numbers and true/false</label>
          <label data-when="to:csv,tsv,xlsx,sql,md" data-when2="from:json,ndjson,xml,yaml" class="check"><input type="checkbox" data-o="expandArrays"> Expand arrays into columns (tags.0, tags.1…)</label>
          <label data-when="to:json,ndjson,yaml,xml" data-when2="from:csv,tsv,xlsx" class="check"><input type="checkbox" data-o="unflatten" checked> Rebuild nested objects from dot.keys</label>
          <label data-when="to:json,ndjson,yaml,xml" data-when2="from:csv,tsv,xlsx" class="check"><input type="checkbox" data-o="parseJsonCells" checked> Parse JSON inside cells</label>
          <label data-when="to:json,yaml,xml">Indent <select data-o="indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tabs</option><option value="min">Minified</option></select></label>
          <label data-when="to:csv">Separator <select data-o="outDelimiter"><option value="comma">Comma</option><option value="semicolon">Semicolon (European Excel)</option></select></label>
          <label data-when="to:csv" class="check"><input type="checkbox" data-o="bom" checked> Add UTF-8 marker so Excel shows accents correctly</label>
          <label data-when="to:xml">Root element <input data-o="xmlRoot" placeholder="root"></label>
          <label data-when="to:xml">Row element <input data-o="xmlRow" placeholder="row"></label>
          <label data-when="to:xlsx">Sheet name <input data-o="sheetName" placeholder="Sheet1"></label>
          <label data-when="to:sql">Table name <input data-o="tableName" placeholder="data"></label>
          <label data-when="to:sql" class="check"><input type="checkbox" data-o="createTable" checked> Include CREATE TABLE</label>
        </div></details>
        <div class="row action-bar"><button class="primary" data-go>Convert</button><button type="button" data-sample>Load sample</button></div>
        <div data-prog hidden></div><div data-result hidden></div>`;
      const paste = $('[data-paste]', el), fromSel = $('[data-from]', el), toSel = $('[data-to]', el), resEl = $('[data-result]', el);
      let file = null, result = null;
      const accept = allowFrom.flatMap(k => Object.keys(EXT).filter(e => EXT[e] === k).map(e => '.' + e)).join(',');
      const refresh = () => {
        const ctx = { from: fromSel.value, to: toSel.value };
        const ok = attr => !attr || attr.split(' ').every(c => { const [k, v] = c.split(':'); return v.split(',').includes(ctx[k]); });
        el.querySelectorAll('[data-when]').forEach(n => n.hidden = !(ok(n.dataset.when) && ok(n.dataset.when2)));
        const noPaste = fromSel.value === 'xlsx'; if (noPaste) paste.hidden = true;
        $('[data-sample]', el).hidden = noPaste;
        [...toSel.options].forEach(o => o.disabled = o.value === fromSel.value && !['json', 'xml', 'yaml'].includes(o.value));
        if (toSel.selectedOptions[0]?.disabled) toSel.value = [...toSel.options].find(o => !o.disabled).value;
      };
      fileSource($('[data-src]', el), { accept, pasteArea: paste, onFile: async x => {
        file = x; resEl.hidden = true;
        if (!x) return;
        paste.hidden = true;
        const k = EXT[extOf(x.name)] || await sniff(x.blob);
        if (allowFrom.includes(k)) { fromSel.value = k; if (toSel.value === k) toSel.value = allowTo.find(t => t !== k); }
        else toast(`This converter expects ${allowFrom.map(f => IN_FORMATS[f]).join(' or ')}.`);
        refresh();
      } });
      fromSel.onchange = toSel.onchange = refresh;
      $('[data-swap]', el).onclick = () => { const f = fromSel.value, t = toSel.value;
        if (!allowFrom.includes(t) || !allowTo.includes(f)) return toast('That direction isn’t available in this converter — try “Any format converter”.');
        fromSel.value = t; toSel.value = f; refresh(); };
      $('[data-sample]', el).onclick = () => { paste.hidden = false; paste.value = SAMPLES[fromSel.value] || ''; file = null; };
      refresh();

      $('[data-go]', el).onclick = async () => {
        let source, name;
        if (file) { source = file.blob; name = file.name; }
        else if (paste.value.trim()) { source = new Blob([paste.value], { type: 'text/plain' }); name = 'pasted.' + fromSel.value; }
        else return toast(fromSel.value === 'xlsx' ? 'Choose an Excel file first' : 'Choose a file or paste some data first');
        const opts = {}; el.querySelectorAll('[data-o]').forEach(i => opts[i.dataset.o] = i.type === 'checkbox' ? i.checked : i.value.trim());
        const prog = progressUI($('[data-prog]', el)); resEl.hidden = true; $('[data-go]', el).disabled = true;
        try {
          result = await runJob({ kind: 'convert', source, from: fromSel.value, to: toSel.value, opts }, prog);
          result.name = name.replace(/\.[^.]+$/, '') + '.' + OUT_EXT[toSel.value];
          showResult(source.size);
        } catch (e) { resEl.hidden = false; resEl.innerHTML = `<div class="out err">${esc(e.message)}</div>`; }
        $('[data-prog]', el).hidden = true; $('[data-go]', el).disabled = false;
      };
      function showResult(inSize) {
        const r = result, tp = r.tablePreview;
        resEl.hidden = false;
        resEl.innerHTML = `<div class="result-head"><div><b>${esc(r.name)}</b><div class="hint">${r.rows.toLocaleString()} ${r.rows === 1 ? 'record' : 'records'}${r.columns != null ? ` · ${r.columns} columns` : ''} · ${fmtBytes(inSize)} → ${fmtBytes(r.blob.size)} · ${(r.ms / 1000).toFixed(1)} s${r.meta.sheet ? ` · sheet “${esc(r.meta.sheet)}” of ${r.meta.sheets.length}` : ''}</div></div>
          <div class="row"><button class="primary" data-dl>Download</button>${canShareFiles() ? '<button data-share>Share</button>' : ''}${r.blob.size < 5e6 && r.textPreview ? '<button data-copy>Copy</button>' : ''}</div></div>
          ${r.notes.map(n => `<p class="hint">${esc(n)}</p>`).join('')}
          ${tp && tp.columns.length ? `<p class="hint">Preview: first ${Math.min(100, r.rows)} of ${r.rows.toLocaleString()} rows</p><div class="table-wrap"><table><thead><tr>${tp.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${tp.rows.map(row => `<tr>${row.map(v => `<td>${esc(v.length > 120 ? v.slice(0, 120) + '…' : v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
          ${r.textPreview ? `<p class="hint">${r.truncated ? 'Preview: first 64 KB of output' : 'Output'}</p><pre class="out preview">${esc(r.textPreview)}</pre>` : ''}`;
        $('[data-dl]', resEl).onclick = () => saveBlob(r.blob, r.name).catch(e => toast(e.message));
        const sh = $('[data-share]', resEl); if (sh) sh.onclick = () => shareBlob(r.blob, r.name);
        const cp = $('[data-copy]', resEl); if (cp) cp.onclick = async () => copy(await r.blob.text());
      }
    };
  }

  const FILE_TOOLS = [
    ...Object.entries(FMT).map(([k, f]) => ({ id: 'fmt-' + k, group: 'Formatters', name: `${f.name} formatter`, desc: `Pretty-print${f.minify ? ' or minify' : ''} ${f.name}${k === 'js' ? ' and TypeScript/JSX' : k === 'css' ? ', SCSS and Less' : ''}. Open a file from your device or paste text.${k === 'yaml' ? ' Comments are not kept.' : ''}`, render: formatterTool(k) })),
    { id: 'conv-any', group: 'Converters', name: 'Any format converter', desc: 'Convert between JSON, NDJSON, CSV, TSV, Excel, XML and YAML. Also exports SQL inserts and Markdown tables.', render: converterTool({}) },
    { id: 'conv-json-csv', group: 'Converters', name: 'JSON ⇄ CSV', desc: 'Nested objects become dot.columns; the reverse rebuilds them.', render: converterTool({ from: ['json', 'ndjson', 'csv', 'tsv'], to: ['csv', 'tsv', 'json', 'ndjson'] }) },
    { id: 'conv-json-xlsx', group: 'Converters', name: 'JSON ⇄ Excel', desc: 'Export JSON to a filtered .xlsx sheet, or read any sheet back to JSON.', render: converterTool({ from: ['json', 'ndjson', 'xlsx'], to: ['xlsx', 'json', 'ndjson'] }) },
    { id: 'conv-csv-xlsx', group: 'Converters', name: 'CSV ⇄ Excel', desc: 'Turn CSV into a typed spreadsheet, or export a sheet to CSV.', render: converterTool({ from: ['csv', 'tsv', 'xlsx'], to: ['xlsx', 'csv', 'tsv'] }) },
    { id: 'conv-xml-json', group: 'Converters', name: 'XML ⇄ JSON', desc: 'Attributes become @keys and text becomes #text, so it converts back cleanly.', render: converterTool({ from: ['xml', 'json'], to: ['json', 'xml'] }) },
    { id: 'conv-xml-table', group: 'Converters', name: 'XML → CSV / Excel', desc: 'Finds the repeating element automatically, or set a records path.', render: converterTool({ from: ['xml'], to: ['csv', 'xlsx', 'tsv'] }) },
    { id: 'conv-yaml-json', group: 'Converters', name: 'YAML ⇄ JSON', desc: 'Multi-document YAML becomes a JSON array.', render: converterTool({ from: ['yaml', 'json'], to: ['json', 'yaml'] }) },
    { id: 'conv-sql', group: 'Converters', name: 'Data → SQL inserts', desc: 'CREATE TABLE with inferred column types, plus batched INSERT statements.', render: converterTool({ from: ['csv', 'json', 'xlsx', 'ndjson', 'tsv'], to: ['sql'] }) }
  ];

  const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');

  const BASIC_TOOLS = [
    { id: 'base64', group: 'Encode & decode', name: 'Base64', desc: 'Encode and decode Base64 (UTF-8 safe).',
      render: el => io(el, { actions: [{ label: 'Encode', fn: b64encUtf8 }, { label: 'Decode', fn: s => { try { return b64decUtf8(s.trim()); } catch { throw new Error('That is not valid Base64.'); } } }] }) },
    { id: 'url', group: 'Encode & decode', name: 'URL encode', desc: 'Percent-encode or decode URL components.',
      render: el => io(el, { actions: [{ label: 'Encode', fn: encodeURIComponent }, { label: 'Decode', fn: decodeURIComponent }, { label: 'Parse URL', fn: s => { const u = new URL(s.trim()); return JSON.stringify({ protocol: u.protocol, host: u.host, pathname: u.pathname, hash: u.hash, params: Object.fromEntries(u.searchParams) }, null, 2); } }] }) },
    { id: 'jwt', group: 'Encode & decode', name: 'JWT decoder', desc: 'Read the header and payload of a JSON Web Token. The signature is not verified.',
      render: el => io(el, { placeholder: 'eyJhbGciOi...', actions: [{ label: 'Decode', fn: s => {
        const p = s.trim().split('.'); if (p.length < 2) throw new Error('A JWT has three dot-separated parts.');
        const dec = x => JSON.parse(b64decUtf8(x.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(x.length / 4) * 4, '=')));
        const payload = dec(p[1]); const notes = [];
        ['iat', 'nbf', 'exp'].forEach(k => payload[k] && notes.push(`${k}: ${new Date(payload[k] * 1000).toLocaleString()}`));
        if (payload.exp) notes.push(payload.exp * 1000 < Date.now() ? 'Status: expired' : 'Status: not expired');
        return `// header\n${JSON.stringify(dec(p[0]), null, 2)}\n\n// payload\n${JSON.stringify(payload, null, 2)}${notes.length ? '\n\n// times\n' + notes.join('\n') : ''}`;
      } }] }) },
    { id: 'hash', group: 'Encode & decode', name: 'Hash generator', desc: 'SHA-1, SHA-256, SHA-384 and SHA-512 digests.',
      render: el => io(el, { actions: [{ label: 'Hash all', fn: async s => {
        const d = new TextEncoder().encode(s); const rows = [];
        for (const a of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) rows.push(`${a}\n${hex(await crypto.subtle.digest(a, d))}`);
        return rows.join('\n\n');
      } }] }) },
    { id: 'uuid', group: 'Generators', name: 'UUID generator', desc: 'Random version 4 UUIDs.',
      render: el => {
        el.innerHTML = `<div class="row"><label style="margin:0">How many</label><input id="n" type="number" min="1" max="500" value="5" style="max-width:100px">
          <label style="margin:0"><input id="up" type="checkbox" style="width:auto"> Uppercase</label>
          <button class="primary" id="go">Generate</button><button class="ghost" id="cp">Copy</button></div><div class="out" id="o" style="margin-top:12px"></div>`;
        const go = () => { const n = Math.min(500, Math.max(1, +$('#n', el).value || 1)); let s = Array.from({ length: n }, uid).join('\n'); if ($('#up', el).checked) s = s.toUpperCase(); $('#o', el).textContent = s; };
        $('#go', el).onclick = go; $('#cp', el).onclick = () => copy($('#o', el).textContent); go();
      } },
    { id: 'regex', group: 'Text', name: 'Regex tester', desc: 'Test JavaScript regular expressions with live highlighting.',
      render: el => {
        el.innerHTML = `<div class="row"><input id="re" class="mono" placeholder="pattern" value="\\b\\w+@\\w+\\.\\w+\\b"><input id="fl" class="mono" value="g" style="max-width:80px" aria-label="flags"></div>
          <label for="tx">Test text</label><textarea id="tx">Reach us at team@devhub.io or ops@example.com</textarea>
          <label>Matches</label><div class="out" id="o"></div><div class="hint" id="info" style="margin-top:6px"></div>`;
        const run = () => {
          const o = $('#o', el), info = $('#info', el), txt = $('#tx', el).value; o.classList.remove('err');
          try {
            let fl = $('#fl', el).value; if (!fl.includes('g')) fl += 'g';
            const re = new RegExp($('#re', el).value, fl); let html = '', last = 0, count = 0, groups = [];
            for (const m of txt.matchAll(re)) {
              if (m[0] === '' ) { continue; }
              html += esc(txt.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; count++;
              if (m.length > 1) groups.push(m.slice(1).map((g, i) => `$${i + 1}=${g}`).join(' '));
            }
            o.innerHTML = html + esc(txt.slice(last)); info.textContent = `${count} match${count === 1 ? '' : 'es'}${groups.length ? ' · groups: ' + groups.join(' | ') : ''}`;
          } catch (e) { o.classList.add('err'); o.textContent = e.message; info.textContent = ''; }
        };
        el.querySelectorAll('input,textarea').forEach(i => i.oninput = run); run();
      } },
    { id: 'time', group: 'Utilities', name: 'Timestamp converter', desc: 'Convert between Unix time and readable dates.',
      render: el => {
        el.innerHTML = `<div class="row"><input id="ts" class="mono" placeholder="Unix seconds or milliseconds, or any date"><button class="primary" id="go">Convert</button><button id="now">Now</button></div><div class="out" id="o" style="margin-top:12px"></div>`;
        const conv = () => {
          const v = $('#ts', el).value.trim(); const o = $('#o', el); o.classList.remove('err');
          let d = /^-?\d+(\.\d+)?$/.test(v) ? new Date(+v < 1e11 ? +v * 1000 : +v) : new Date(v);
          if (isNaN(d)) { o.classList.add('err'); o.textContent = 'Enter a Unix timestamp or a date like 2026-09-26 14:30.'; return; }
          const rel = Math.round((d - Date.now()) / 60000);
          o.textContent = `Local      ${d.toLocaleString()}\nUTC        ${d.toUTCString()}\nISO 8601   ${d.toISOString()}\nUnix (s)   ${Math.floor(d / 1000)}\nUnix (ms)  ${d.getTime()}\nRelative   ${Math.abs(rel) < 1 ? 'now' : new Intl.RelativeTimeFormat().format(Math.abs(rel) < 60 ? rel : Math.abs(rel) < 1440 ? Math.round(rel / 60) : Math.round(rel / 1440), Math.abs(rel) < 60 ? 'minute' : Math.abs(rel) < 1440 ? 'hour' : 'day')}`;
        };
        $('#go', el).onclick = conv; $('#now', el).onclick = () => { $('#ts', el).value = Math.floor(Date.now() / 1000); conv(); };
        $('#ts', el).onkeydown = e => e.key === 'Enter' && conv(); $('#now', el).click();
      } },
    { id: 'color', group: 'Utilities', name: 'Color converter', desc: 'Convert HEX, RGB and HSL.',
      render: el => {
        el.innerHTML = `<div class="row"><input id="c" type="color" value="#3346d3" style="max-width:64px;height:42px;padding:2px"><input id="t" class="mono" value="#3346d3" placeholder="#hex, rgb(), hsl()"></div>
          <div class="swatch" id="sw" style="margin:12px 0"></div><div class="kv" id="kv"></div>`;
        const toHsl = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
          if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
          return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]; };
        const parse = v => { const ctx = document.createElement('canvas').getContext('2d'); ctx.fillStyle = '#000'; ctx.fillStyle = v; const f = ctx.fillStyle;
          if (f === '#000000' && !/^(#0{3,6}|black|rgb\(\s*0\s*,\s*0\s*,\s*0)/i.test(v.trim())) return null; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const show = v => { const rgb = parse(v); if (!rgb) return; const [r, g, b] = rgb; const hx = '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join(''); const [h, s, l] = toHsl(r, g, b);
          $('#sw', el).style.background = hx; $('#c', el).value = hx;
          const lum = [r, g, b].map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); const L = .2126 * lum[0] + .7152 * lum[1] + .0722 * lum[2];
          const rows = { HEX: hx, RGB: `rgb(${r}, ${g}, ${b})`, HSL: `hsl(${h}, ${s}%, ${l}%)`, 'vs white': `${((1.05) / (L + .05)).toFixed(2)}:1 contrast`, 'vs black': `${((L + .05) / .05).toFixed(2)}:1 contrast` };
          $('#kv', el).innerHTML = Object.entries(rows).map(([k, v]) => `<b>${k}</b><span class="mono">${v}</span><button class="ghost" data-v="${esc(v)}">Copy</button>`).join('');
          el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => copy(b.dataset.v)); };
        $('#c', el).oninput = e => { $('#t', el).value = e.target.value; show(e.target.value); }; $('#t', el).oninput = e => show(e.target.value); show('#3346d3');
      } },
    { id: 'case', group: 'Text', name: 'Case converter', desc: 'camelCase, snake_case, kebab-case and more, plus counts.',
      render: el => io(el, { sample: 'user profile settings', actions: [{ label: 'Convert', fn: s => { const w = words(s);
        return `camelCase      ${w.map((x, i) => i ? cap(x) : x).join('')}\nPascalCase     ${w.map(cap).join('')}\nsnake_case     ${w.join('_')}\nCONSTANT_CASE  ${w.join('_').toUpperCase()}\nkebab-case     ${w.join('-')}\ndot.case       ${w.join('.')}\nTitle Case     ${w.map(cap).join(' ')}\nUPPER          ${s.toUpperCase()}\nlower          ${s.toLowerCase()}\n\n${s.length} characters, ${s.trim() ? s.trim().split(/\s+/).length : 0} words, ${s.split('\n').length} lines`; } }] }) },
    { id: 'diff', group: 'Text', name: 'Text diff', desc: 'Compare two texts line by line.',
      render: el => {
        el.innerHTML = `<div class="grid2"><div><label for="a">Original</label><textarea id="a">const port = 3000;\napp.listen(port);</textarea></div><div><label for="b">Changed</label><textarea id="b">const port = process.env.PORT || 3000;\napp.listen(port);\nconsole.log("ready");</textarea></div></div>
          <div class="row" style="margin-top:12px"><button class="primary" id="go">Compare</button></div><div class="out" id="o" style="margin-top:12px"></div>`;
        $('#go', el).onclick = () => { const o = $('#o', el); o.classList.remove('err'); try { o.innerHTML = lineDiff($('#a', el).value, $('#b', el).value); } catch (e) { o.classList.add('err'); o.textContent = e.message; } };
        $('#go', el).click();
      } },
    { id: 'password', group: 'Generators', name: 'Password generator', desc: 'Strong random passwords generated on your device.',
      render: el => {
        el.innerHTML = `<div class="row"><label style="margin:0">Length</label><input id="len" type="number" min="8" max="128" value="24" style="max-width:90px">
          ${['lower', 'upper', 'digits', 'symbols'].map(k => `<label style="margin:0"><input type="checkbox" id="${k}" checked style="width:auto"> ${k}</label>`).join('')}
          <button class="primary" id="go">Generate</button><button class="ghost" id="cp">Copy</button></div><div class="out" id="o" style="margin-top:12px;font-size:1.05rem"></div><div class="hint" id="bits"></div>`;
        const sets = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!@#$%^&*()-_=+[]{};:,.?' };
        const go = () => { const pool = Object.keys(sets).filter(k => $('#' + k, el).checked).map(k => sets[k]).join('');
          if (!pool) { $('#o', el).textContent = 'Pick at least one character set.'; return; }
          const n = Math.min(128, Math.max(8, +$('#len', el).value || 24)); const r = new Uint32Array(n); crypto.getRandomValues(r);
          $('#o', el).textContent = [...r].map(x => pool[x % pool.length]).join(''); $('#bits', el).textContent = `≈ ${Math.round(n * Math.log2(pool.length))} bits of entropy`; };
        $('#go', el).onclick = go; $('#cp', el).onclick = () => copy($('#o', el).textContent); go();
      } },
    { id: 'html', group: 'Encode & decode', name: 'HTML entities', desc: 'Escape and unescape HTML.',
      render: el => io(el, { sample: '<a href="/x?a=1&b=2">Link</a>', actions: [{ label: 'Escape', fn: esc }, { label: 'Unescape', fn: s => new DOMParser().parseFromString(`<!doctype html><body>${s}`, 'text/html').body.textContent }] }) },
    { id: 'base', group: 'Utilities', name: 'Number base', desc: 'Convert between binary, octal, decimal and hex.',
      render: el => io(el, { inLabel: 'Number (prefix 0x, 0b, 0o or plain decimal)', sample: '0xFF', actions: [{ label: 'Convert', fn: s => {
        const v = s.trim().toLowerCase(); let n;
        try { n = BigInt(v.startsWith('-') ? '-' + v.slice(1) : v); } catch { throw new Error('Use 255, 0xff, 0b1010 or 0o17.'); }
        const neg = n < 0n, a = neg ? -n : n, sg = neg ? '-' : '';
        return `Decimal  ${n.toString()}\nHex      ${sg}0x${a.toString(16)}\nOctal    ${sg}0o${a.toString(8)}\nBinary   ${sg}0b${a.toString(2)}`;
      } }] }) },
    { id: 'lorem', group: 'Generators', name: 'Lorem ipsum', desc: 'Placeholder paragraphs.',
      render: el => {
        el.innerHTML = `<div class="row"><label style="margin:0">Paragraphs</label><input id="p" type="number" min="1" max="20" value="3" style="max-width:90px"><button class="primary" id="go">Generate</button><button class="ghost" id="cp">Copy</button></div><div class="out" id="o" style="margin-top:12px;word-break:normal;font-family:var(--sans)"></div>`;
        const para = () => { const n = 40 + Math.floor(Math.random() * 30); const w = Array.from({ length: n }, () => LOREM[Math.floor(Math.random() * LOREM.length)]); const s = w.join(' '); return cap(s) + '.'; };
        const go = () => { $('#o', el).textContent = Array.from({ length: Math.min(20, Math.max(1, +$('#p', el).value || 1)) }, para).join('\n\n'); };
        $('#go', el).onclick = go; $('#cp', el).onclick = () => copy($('#o', el).textContent); go();
      } },
    { id: 'cron', group: 'Utilities', name: 'Cron explainer', desc: 'Describe a 5-field cron expression and list upcoming runs.',
      render: el => io(el, { inLabel: 'Cron expression (min hour day month weekday)', sample: '*/15 9-17 * * 1-5', actions: [{ label: 'Explain', fn: s => {
        const f = s.trim().split(/\s+/); if (f.length !== 5) throw new Error('Use 5 fields: minute hour day-of-month month day-of-week.');
        const rng = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
        const expand = (x, [lo, hi]) => { const set = new Set(); for (const part of x.split(',')) { let [r, st] = part.split('/'); st = st ? +st : 1; let a = lo, b = hi;
          if (r !== '*') { [a, b] = r.split('-').map(Number); if (b === undefined) b = st > 1 ? hi : a; }
          if ([a, b, st].some(v => isNaN(v)) || a < lo || b > hi) throw new Error(`"${part}" is out of range ${lo}-${hi}.`); for (let i = a; i <= b; i += st) set.add(i === 7 && hi === 6 ? 0 : i); } return set; };
        const S = f.map((x, i) => expand(x.replace(/^7$/, '0'), rng[i])); const runs = []; const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
        for (let i = 0; i < 525600 && runs.length < 8; i++) { if (S[0].has(d.getMinutes()) && S[1].has(d.getHours()) && S[3].has(d.getMonth() + 1) &&
          ((f[2] === '*' || f[4] === '*') ? (S[2].has(d.getDate()) && S[4].has(d.getDay())) : (S[2].has(d.getDate()) || S[4].has(d.getDay())))) runs.push(d.toLocaleString()); d.setMinutes(d.getMinutes() + 1); }
        const names = ['Minute', 'Hour', 'Day of month', 'Month', 'Day of week'];
        return f.map((x, i) => `${names[i].padEnd(13)} ${x}`).join('\n') + `\n\nNext runs (local time)\n${runs.join('\n') || 'None in the next year'}`;
      } }] }) }
  ];
  const GROUPS = ['Formatters', 'Converters', 'Encode & decode', 'Text', 'Generators', 'Utilities'];
  const TOOLS = [...FILE_TOOLS, ...BASIC_TOOLS].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));

  // ---------- views ----------
  const view = () => $('#view');
  const syncLine = () => session.user ? `<div class="mobile-sync">${esc($('#syncStatus')?.textContent || '')}</div>` : '';

  function renderTools(sub) {
    const t = TOOLS.find(x => x.id === sub) || TOOLS[0];
    const grouped = GROUPS.map(g => [g, TOOLS.filter(x => x.group === g)]).filter(([, l]) => l.length);
    view().innerHTML = `${syncLine()}<h1>Developer tools</h1><p class="lede">${TOOLS.length} tools in ${grouped.length} groups. Everything runs on your device — nothing you open or paste is uploaded.</p>
      <label class="picker"><span class="sr">Choose a tool</span><select id="picker">${grouped.map(([g, l]) => `<optgroup label="${esc(g)}">${l.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="tools"><nav class="tool-list" aria-label="Tools"><input id="tf" type="search" placeholder="Filter tools" aria-label="Filter tools">
      ${grouped.map(([g, l]) => `<div class="tool-group" data-g><h3>${esc(g)}</h3>${l.map(x => `<button data-id="${x.id}" class="${x.id === t.id ? 'active' : ''}" ${x.id === t.id ? 'aria-current="page"' : ''}>${esc(x.name)}</button>`).join('')}</div>`).join('')}</nav>
      <section class="workspace panel"><div class="ws-head"><span class="ws-group">${esc(t.group)}</span><h2>${esc(t.name)}</h2></div><p class="hint ws-desc">${esc(t.desc)}</p><div id="ws"></div></section></div>`;
    view().querySelectorAll('.tool-list button').forEach(b => b.onclick = () => location.hash = `tools/${b.dataset.id}`);
    $('#picker').onchange = e => location.hash = `tools/${e.target.value}`;
    $('#tf').oninput = e => { const q = e.target.value.toLowerCase();
      view().querySelectorAll('.tool-group').forEach(g => { let any = false; g.querySelectorAll('button').forEach(b => { const hit = (b.textContent + ' ' + g.firstElementChild.textContent).toLowerCase().includes(q); b.hidden = !hit; any ||= hit; }); g.hidden = !any; }); };
    cancelJob();
    t.render($('#ws'));
  }

  // ---------- tool store links (per user) ----------
  let linkQuery = '', linkCat = '';
  function renderLinks() {
    const links = (data.get('links') || []).filter(l => !l.deleted);
    const saveLinks = next => data.set('links', next);
    const cats = [...new Set(links.map(l => l.category || 'Other'))].sort();
    const q = linkQuery.toLowerCase();
    const shown = links.filter(l => (!linkCat || (l.category || 'Other') === linkCat) && (!q || [l.name, l.url, l.notes, l.category].join(' ').toLowerCase().includes(q)));
    const groups = {}; shown.forEach(l => (groups[l.category || 'Other'] ||= []).push(l));
    view().innerHTML = `${syncLine()}<h1>Tool stores</h1><p class="lede">Package registries, marketplaces and references. Only you can see your list.</p>
      <div class="links-bar"><input id="q" type="search" placeholder="Search links" value="${esc(linkQuery)}" aria-label="Search links">
        <select id="cf" aria-label="Category"><option value="">All categories</option>${cats.map(c => `<option ${c === linkCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <button class="primary" id="new">Add link</button></div>
      ${Object.keys(groups).sort().map(c => `<section class="cat"><h2>${esc(c)} <span class="hint">${groups[c].length}</span></h2><div class="link-grid">${groups[c].map(l => `
        <div class="link"><a href="${esc(/^https?:\/\//i.test(l.url) ? l.url : '#')}" target="_blank" rel="noopener">${esc(l.name)}</a><span class="u">${esc(l.url.replace(/^https?:\/\//, ''))}</span>${l.notes ? `<span class="n">${esc(l.notes)}</span>` : ''}
        <div class="acts"><button data-edit="${l.id}">Edit</button><button class="danger" data-rm="${l.id}">Delete</button></div></div>`).join('')}</div></section>`).join('')
      || `<p class="empty">${links.length ? 'No links match that search.' : 'No links yet. Add your first tool store.'}</p>`}
      <dialog id="dlg"><form method="dialog" id="lf"><h2 id="dt">Add link</h2>
        <label for="ln">Name</label><input id="ln" required><label for="lu">URL</label><input id="lu" type="url" required placeholder="https://">
        <label for="lc">Category</label><input id="lc" list="cl" placeholder="e.g. Package registries"><datalist id="cl">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <label for="lnotes">Notes</label><input id="lnotes"><div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save link</button></div></form></dialog>`;
    $('#q').oninput = e => { linkQuery = e.target.value; const pos = e.target.selectionStart; renderLinks(); const i = $('#q'); i.focus(); i.setSelectionRange(pos, pos); };
    $('#cf').onchange = e => { linkCat = e.target.value; renderLinks(); };
    const dlg = $('#dlg'); let editing = null;
    const open = l => { editing = l; $('#dt').textContent = l ? 'Edit link' : 'Add link'; $('#ln').value = l?.name || ''; $('#lu').value = l?.url || ''; $('#lc').value = l?.category || linkCat || ''; $('#lnotes').value = l?.notes || ''; dlg.showModal(); };
    $('#new').onclick = () => open(null);
    dlg.onclose = () => { if (dlg.returnValue !== 'ok') return;
      const all = data.get('links') || [], now = new Date().toISOString();
      const v = { name: $('#ln').value.trim(), url: $('#lu').value.trim(), category: $('#lc').value.trim() || 'Other', notes: $('#lnotes').value.trim(), updatedAt: now };
      saveLinks(editing ? all.map(x => x.id === editing.id ? { ...x, ...v } : x) : [...all, { id: uid(), ...v }]);
      renderLinks(); toast(editing ? 'Link updated' : 'Link added'); };
    view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => open(links.find(l => l.id === b.dataset.edit)));
    view().querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const all = data.get('links') || [], l = all.find(x => x.id === b.dataset.rm);
      saveLinks(all.map(x => x === l ? { ...x, deleted: true, updatedAt: new Date().toISOString() } : x)); renderLinks();
      toast(`Deleted “${l.name}”`, { label: 'Undo', fn: () => { saveLinks((data.get('links') || []).map(x => x.id === l.id ? { ...x, deleted: false, updatedAt: new Date().toISOString() } : x)); renderLinks(); } });
    });
  }

  // ---------- sign in / register ----------
  const fieldErrors = (form, fields = {}) => {
    form.querySelectorAll('.field-err').forEach(e => e.remove());
    form.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
    Object.entries(fields).forEach(([k, msg]) => { const i = form.querySelector(`[name="${k}"]`); if (!i) return; i.setAttribute('aria-invalid', 'true'); i.insertAdjacentHTML('afterend', `<p class="field-err">${esc(msg)}</p>`); });
    const first = form.querySelector('[aria-invalid]'); if (first) first.focus();
  };
  const pwToggle = form => form.querySelectorAll('.pw-toggle').forEach(b => b.onclick = () => { const i = b.previousElementSibling; const show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', show); });
  const nextRoute = () => new URLSearchParams(location.hash.split('?')[1] || '').get('next') || 'tasks';
  const authShell = inner => `<div class="auth"><div class="auth-card"><div class="auth-brand"><span class="brand-mark">{ }</span><span>DevHub</span></div>${inner}</div>
    <p class="auth-foot hint">Your tasks and links are private to your account.${API ? '' : ''} The developer tools work without signing in — <a href="#tools">open tools</a>.</p></div>`;

  function renderLogin() {
    if (session.user) { location.hash = nextRoute(); return; }
    view().innerHTML = authShell(`<h1>Sign in</h1><p class="hint auth-sub">Welcome back. Sign in to see your tasks.</p>
      <form id="af" novalidate>
        <label for="login">Username or email</label><input id="login" name="login" autocomplete="username" autocapitalize="off" spellcheck="false" required>
        <label for="password">Password</label><div class="pw"><input id="password" name="password" type="password" autocomplete="current-password" required><button type="button" class="pw-toggle ghost" aria-pressed="false">Show</button></div>
        <label class="check-line"><input type="checkbox" name="remember" checked> Keep me signed in on this device</label>
        <p class="form-err" role="alert" hidden></p>
        <button class="primary wide">Sign in</button>
      </form>
      <p class="auth-switch">New here? <a href="#register${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}">Create an account</a></p>`);
    const f = $('#af'); pwToggle(f); $('#login').focus();
    f.onsubmit = async e => {
      e.preventDefault(); const btn = $('button.primary', f), err = $('.form-err', f); err.hidden = true;
      if (!f.login.value.trim() || !f.password.value) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      try { const r = await api('/auth/login', { method: 'POST', body: { login: f.login.value, password: f.password.value } }); startSession(r.token, r.user, f.remember.checked); toast(`Welcome back, ${r.user.name.split(' ')[0]}`); location.hash = nextRoute(); }
      catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in'; f.password.select(); }
    };
  }

  function strength(pw) {
    let s = 0; if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
    return pw ? Math.min(4, Math.max(1, s - (pw.length < 8 ? 1 : 0))) : 0;
  }
  function renderRegister() {
    if (session.user) { location.hash = nextRoute(); return; }
    const closed = serverConfig.registration === 'closed', code = serverConfig.registration === 'code';
    view().innerHTML = authShell(closed ? `<h1>Registration is closed</h1><p class="hint auth-sub">Ask the administrator of this DevHub to create an account for you.</p><a class="btn primary wide" href="#login">Back to sign in</a>` :
      `<h1>Create your account</h1><p class="hint auth-sub">Plan your day, track time and keep your tool links — synced across your devices.</p>
      <form id="af" novalidate>
        <label for="name">Full name</label><input id="name" name="name" autocomplete="name" required>
        <label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required placeholder="e.g. ada.l">
        <label for="email">Email <span class="opt">optional — lets you sign in with it</span></label><input id="email" name="email" type="email" autocomplete="email">
        <label for="password">Password</label><div class="pw"><input id="password" name="password" type="password" autocomplete="new-password" required minlength="8"><button type="button" class="pw-toggle ghost" aria-pressed="false">Show</button></div>
        <div class="meter" aria-hidden="true"><span></span><span></span><span></span><span></span></div><p class="hint meter-text">At least 8 characters.</p>
        <label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
        ${code ? `<label for="code">Invite code</label><input id="code" name="code" autocomplete="off" required>` : ''}
        <p class="form-err" role="alert" hidden></p>
        <button class="primary wide">Create account</button>
      </form>
      <p class="auth-switch">Already have an account? <a href="#login">Sign in</a></p>`);
    const f = $('#af'); if (!f) return; pwToggle(f); $('#name').focus();
    const labels = ['At least 8 characters.', 'Weak — add length or variety.', 'Fair — a longer passphrase is stronger.', 'Good.', 'Strong.'];
    f.password.oninput = () => { const s = strength(f.password.value); f.querySelectorAll('.meter span').forEach((b, i) => b.className = i < s ? 'on s' + s : ''); $('.meter-text', f).textContent = labels[s]; };
    f.onsubmit = async e => {
      e.preventDefault(); const btn = $('button.primary', f), err = $('.form-err', f); err.hidden = true;
      const local = {};
      if (!f.name.value.trim()) local.name = 'Enter your name.';
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(f.username.value.trim())) local.username = 'Use 3–32 letters, numbers, dots, dashes or underscores.';
      if (f.email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) local.email = 'Enter a valid email address, or leave it blank.';
      if (f.password.value.length < 8) local.password = 'Use at least 8 characters.';
      else if (f.password.value !== f.confirm.value) local.confirm = 'Passwords don’t match.';
      if (code && !f.code.value.trim()) local.code = 'Enter your invite code.';
      fieldErrors(f, local); if (Object.keys(local).length) return;
      btn.disabled = true; btn.textContent = 'Creating account…';
      try {
        const r = await api('/auth/register', { method: 'POST', body: { name: f.name.value, username: f.username.value, email: f.email.value, password: f.password.value, code: f.code?.value } });
        startSession(r.token, r.user, true); toast(`Welcome, ${r.user.name.split(' ')[0]}! Your account is ready.`); location.hash = nextRoute();
      } catch (x) { fieldErrors(f, x.body?.fields); err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Create account'; }
    };
  }

  // ---------- account ----------
  function renderAccount() {
    const u = session.user;
    view().innerHTML = `${syncLine()}<h1>Account</h1><p class="lede">Signed in as <b>${esc(u.username)}</b>. Your data is stored privately under your account.</p>
      <div class="acct-grid">
        <section class="panel"><h2>Profile</h2><form id="pf" novalidate>
          <label for="pn">Full name</label><input id="pn" name="name" value="${esc(u.name)}" autocomplete="name">
          <label for="pe">Email</label><input id="pe" name="email" type="email" value="${esc(u.email)}" autocomplete="email">
          <p class="hint">Member since ${new Date(u.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <button class="primary">Save profile</button></form></section>
        <section class="panel"><h2>Password</h2><form id="pwf" novalidate>
          <label for="cur">Current password</label><input id="cur" name="current" type="password" autocomplete="current-password">
          <label for="nx">New password</label><input id="nx" name="next" type="password" autocomplete="new-password" minlength="8">
          <p class="hint">Changing your password signs you out on your other devices.</p>
          <button class="primary">Change password</button></form></section>
        <section class="panel"><h2>Sync and data</h2>
          <p class="hint" id="acctSync">${data.hasUnsynced() ? 'Some changes are waiting to sync.' : 'Everything is synced.'}</p>
          <div class="row"><button id="syncNow">Sync now</button><button id="ex">Export my data</button><label class="btn" style="margin:0">Import backup<input type="file" id="im" accept="application/json,.json" hidden></label></div>
          <p class="hint" style="margin-top:10px">Export downloads your tasks, projects and links as one JSON file.</p></section>
        <section class="panel"><h2>Sessions</h2>
          <div class="row"><button id="so">Sign out</button><button id="soa">Sign out on all devices</button></div>
          <h2 style="margin-top:22px">Delete account</h2><p class="hint">Permanently deletes your account and all your tasks and links.</p>
          <button class="danger" id="del">Delete account…</button></section>
      </div>`;
    const pf = $('#pf');
    pf.onsubmit = async e => { e.preventDefault(); fieldErrors(pf);
      try { const r = await api('/auth/profile', { method: 'POST', body: { name: pf.name.value, email: pf.email.value } }); session.setUser(r.user); renderNavUser(); toast('Profile saved'); }
      catch (x) { fieldErrors(pf, x.body?.fields); toast(x.message); } };
    const pwf = $('#pwf');
    pwf.onsubmit = async e => { e.preventDefault(); fieldErrors(pwf);
      if (pwf.next.value.length < 8) return fieldErrors(pwf, { next: 'Use at least 8 characters.' });
      try { const r = await api('/auth/password', { method: 'POST', body: { current: pwf.current.value, next: pwf.next.value } }); session.save(r.token, r.user, !!localStorage.getItem('devhub:token')); pwf.reset(); toast('Password changed'); }
      catch (x) { fieldErrors(pwf, x.body?.fields); if (!x.body?.fields) toast(x.message); } };
    $('#syncNow').onclick = async () => { await pull(); await push(); $('#acctSync').textContent = data.hasUnsynced() ? 'Some changes are waiting to sync.' : 'Everything is synced.'; };
    $('#ex').onclick = () => saveBlob(new Blob([JSON.stringify({ app: 'devhub', exported: new Date().toISOString(), user: u.username, tasks: data.get('tasks'), links: data.get('links'), prefs: data.get('prefs') }, null, 2)], { type: 'application/json' }), `devhub-${u.username}-${dayKey(new Date())}.json`);
    $('#im').onchange = async e => { const file = e.target.files[0]; if (!file) return;
      try { const j = JSON.parse(await file.text()); if (!j.tasks && !j.links) throw 0;
        if (!confirm('Replace your current tasks and links with this backup?')) return;
        if (j.tasks) data.set('tasks', j.tasks); if (j.links) data.set('links', j.links); if (j.prefs) data.set('prefs', j.prefs); data.changed(); toast('Backup imported');
      } catch { toast('That file isn’t a DevHub backup'); } e.target.value = ''; };
    $('#so').onclick = signOut;
    $('#soa').onclick = async () => { if (!confirm('Sign out on every device, including this one?')) return; try { await push(); await api('/auth/logout-all', { method: 'POST' }); } catch (x) { return toast(x.message); } const id = session.user.id; data.wipe(id); session.clear(); renderNavUser(); location.hash = 'login'; toast('Signed out on all devices'); };
    $('#del').onclick = async () => { const pw = prompt('This permanently deletes your account and data. Enter your password to confirm:'); if (!pw) return;
      try { await api('/auth/account', { method: 'DELETE', body: { password: pw } }); const id = session.user.id; data.wipe(id); session.clear(); renderNavUser(); location.hash = 'register'; toast('Your account was deleted'); } catch (x) { toast(x.message); } };
  }

  // ---------- router ----------
  const routes = { tools: sub => renderTools(sub), links: renderLinks, account: renderAccount, login: renderLogin, register: renderRegister };
  const PRIVATE = new Set(['tasks', 'links', 'account']);
  function render() {
    let [route, sub] = (location.hash.slice(1).split('?')[0] || 'tools').split('/');
    if (route === 'today' || route === 'settings') route = route === 'today' ? 'tasks' : 'account';
    if (PRIVATE.has(route) && !session.user) { location.replace('#login?next=' + route); return; }
    document.querySelectorAll('.nav a[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === route || (route === 'register' && a.dataset.route === 'login')));
    document.body.dataset.route = route;
    (routes[route] || routes.tools)(sub);
  }
  window.addEventListener('hashchange', () => { render(); view().focus({ preventScroll: true }); window.scrollTo(0, 0); });
  window.addEventListener('online', () => { if (session.user) pull(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session.user && !pushing) pull(); });
  data.listeners.add(() => { const r = document.body.dataset.route; if ((r === 'tasks' || r === 'links') && !document.querySelector('dialog[open]')) render(); });

  // Shared with tasks.js
  window.DH = { $, esc, toast, uid, dayKey, addDays, store, data, session, api, routes, render, copy, saveBlob, view, syncLine };

  window.addEventListener('DOMContentLoaded', () => {
    if (session.user && session.token) data.load(); else session.clear();
    renderNavUser();
    render();
    api('/config').then(c => { serverConfig = c; if (document.body.dataset.route === 'register') render(); }).catch(() => {});
    if (session.user) { pull(); api('/auth/me').then(r => { session.setUser(r.user); renderNavUser(); }).catch(() => {}); }
    if ('serviceWorker' in navigator && !isNative()) navigator.serviceWorker.register('sw.js').catch(console.error);
  });
})();
