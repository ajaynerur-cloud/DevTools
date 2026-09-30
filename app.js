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
    ns: null,
    key(k) { return `devhub:u:${this.ns}:${k}`; },
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
    document.querySelectorAll('.mobile-sync .ms-text').forEach(m => m.textContent = text);
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
  function schedulePush() { if (offline.active()) return markOfflineDirty(); setStatus('Unsaved changes…', 'busy'); clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }

  function startSession(token, user, remember) {
    if (offline.meta) { clearTimeout(offline.timer); data.wipe('offline'); offline.setMeta(null); offline.handle = null; idb.del('offline-handle'); }
    session.save(token, user, remember);
    data.ns = user.id; data.load(); renderNavUser(); pull();
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
      : offline.meta ? `<a href="#account" class="user-chip" data-route="account"><span class="avatar db" aria-hidden="true">DB</span><span class="uc-text"><b>${esc(offline.meta.name)}</b><span class="sync" id="syncStatus">Offline</span></span></a><button type="button" class="db-save primary" data-save-db hidden>Save file</button>`
      : `<a href="#start" class="user-chip signin" data-route="start">Sign in or use offline</a>`;
    const acc = $('.nav a[data-route="account"].nav-link'); if (acc) acc.textContent = u ? 'Account' : offline.meta ? 'Database' : 'Start';
  }

  // ---------- offline database mode (no account; data lives in a JSON or SQLite file) ----------
  const canFSA = () => 'showSaveFilePicker' in window && 'showOpenFilePicker' in window && window.isSecureContext && !isNative();
  const idb = {
    open() { return this.p ||= new Promise((res, rej) => { const r = indexedDB.open('devhub', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async run(mode, fn) { try { const db = await this.open(); return await new Promise((res, rej) => { const tx = db.transaction('kv', mode); const q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); } catch { return undefined; } },
    get(k) { return this.run('readonly', s => s.get(k)); },
    set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
    del(k) { return this.run('readwrite', s => s.delete(k)); }
  };
  const offline = {
    meta: store.get('devhub:offline', null), handle: null, saving: false, needsPermission: false, timer: null,
    active() { return !session.user && !!this.meta; },
    setMeta(m) { this.meta = m; m ? store.set('devhub:offline', m) : store.del('devhub:offline'); }
  };
  const FILE_TYPES = [{ description: 'Task database (DevHub or your own)', accept: { 'application/json': ['.json'], 'application/vnd.sqlite3': ['.sqlite', '.sqlite3', '.db', '.db3'], 'application/xml': ['.xml'] } }];
  const slug = s => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'devhub-tasks').slice(0, 40);

  function offlineStatus() {
    const m = offline.meta; if (!m || session.user) return;
    let text, cls = '';
    if (offline.saving) { text = 'Saving to file…'; cls = 'busy'; }
    else if (offline.needsPermission) { text = 'Press Save to reconnect the file'; cls = 'err'; }
    else if (m.fileDirty) { text = offline.handle ? 'Unsaved changes…' : 'Kept in this browser · not in file yet'; cls = offline.handle ? 'busy' : ''; }
    else text = m.savedAt ? `Saved to file ${new Date(m.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Ready';
    setStatus(text, cls);
    document.querySelectorAll('[data-save-db]').forEach(b => b.hidden = !(m.fileDirty || offline.needsPermission));
  }
  async function saveOffline({ as } = {}) {
    const m = offline.meta; if (!m) return false;
    if (offline.saving && !as) { clearTimeout(offline.timer); offline.timer = setTimeout(() => saveOffline(), 500); return false; }
    const format = as || m.format;
    offline.saving = true; offlineStatus();
    try {
      let blob;
      if (m.adapter && !as) {
        const src = await idb.get('offline-source');
        if (!src) throw new Error('the original file isn’t in this browser any more — open it again from the Database page');
        const res = await DevHubAdapter.write(src, data.docs, m.adapter.mapping);
        blob = res.blob; await idb.set('offline-source', blob); data.persist();
      } else blob = await DevHubDB.encode(format, data.docs, m);
      if (!as && offline.handle) {
        let perm = await offline.handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await offline.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
        if (perm !== 'granted') { offline.needsPermission = true; return false; }
        const w = await offline.handle.createWritable(); await w.write(blob); await w.close();
        offline.needsPermission = false;
      } else await saveBlob(blob, as ? m.fileName.replace(/\.[^.]+$/, '') + (m.adapter ? '-devhub' : '') + DevHubDB.ext(format) : m.fileName);
      if (!as) { m.fileDirty = false; m.savedAt = new Date().toISOString(); offline.setMeta(m); }
      return true;
    } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t save the database: ' + e.message); return false; }
    finally { offline.saving = false; offlineStatus(); }
  }
  function markOfflineDirty() {
    const m = offline.meta; m.fileDirty = true; offline.setMeta(m);
    if (offline.handle && !offline.needsPermission) { clearTimeout(offline.timer); offline.timer = setTimeout(() => saveOffline(), 700); }
    offlineStatus();
  }
  function activateOffline(meta, docs, handle) {
    if (session.user) { data.wipe(session.user.id); session.clear(); }
    data.wipe('offline'); data.ns = 'offline'; data.docs = docs; data.ver = {}; data.dirty = {}; data.persist();
    offline.setMeta(meta); offline.handle = handle || null; offline.needsPermission = false;
    handle ? idb.set('offline-handle', handle) : idb.del('offline-handle');
    renderNavUser(); offlineStatus();
  }
  async function closeOffline() {
    if (offline.meta?.fileDirty) {
      if (confirm('Some changes aren’t in the database file yet. Save the file first?')) { if (!(await saveOffline())) return false; }
      else if (!confirm('Close without saving? Changes since your last save will be lost.')) return false;
    }
    clearTimeout(offline.timer); data.wipe('offline'); data.docs = {}; offline.setMeta(null); offline.handle = null; idb.del('offline-handle'); idb.del('offline-source'); renderNavUser();
    return true;
  }
  // ---------- your own file (any .db / .json / .xml) as the task list ----------
  const maps = { all() { return store.get('devhub:maps', {}); }, save(m) { const a = this.all(); a[m.fingerprint] = m; store.set('devhub:maps', a); } };
  let pendingCustom = null;
  async function openCustomFile(file, handle, next, { remap } = {}) {
    const info = await DevHubAdapter.inspect(file);
    if (!info.collections.length) throw new Error(`No list of records was found in ${file.name}, so it can’t be used as a task list.`);
    const saved = !remap && Object.values(maps.all()).find(m => info.collections.some(c => m.collection === c.id && DevHubAdapter.fingerprint(info, c.id) === m.fingerprint));
    if (saved && saved.mode !== 'import') return activateCustom(file, handle, saved, next);
    const mapping = (remap && offline.meta?.adapter?.mapping) || (saved ? JSON.parse(JSON.stringify(saved)) : DevHubAdapter.guess(info));
    pendingCustom = { file, handle, info, next, mapping, mode: remap === 'import' ? 'import' : mapping.mode || 'adapt', impFormat: 'json', impName: file.name.replace(/\.[^.]+$/, '') };
    location.hash = 'mapfile';
  }
  async function activateCustom(file, handle, mapping, next) {
    const r = await DevHubAdapter.read(file, mapping), now = new Date().toISOString();
    await idb.set('offline-source', file.slice(0, file.size, file.type));
    const labels = DevHubAdapter.labels(mapping);
    activateOffline({ id: uid(), name: file.name.replace(/\.[^.]+$/, ''), format: mapping.fingerprint.split('|')[0], fileName: file.name, createdAt: now, savedAt: now, fileDirty: false,
      adapter: { mapping, labels, choices: r.choices, extraFields: r.extraFields } }, r.docs, handle);
    const n = r.docs.tasks.tasks.length, done = r.docs.tasks.tasks.filter(t => t.status === 'done').length;
    toast(`Opened ${file.name} · ${n} task${n === 1 ? '' : 's'}, ${done} done`);
    location.hash = next || 'tasks';
  }
  // Copy your file's tasks into a NEW standard DevHub database (JSON or SQLite). The original file isn't changed.
  async function importCustom(file, mapping, format, name, next) {
    const r = await DevHubAdapter.read(file, mapping), docs = r.docs, now = new Date().toISOString();
    for (const t of docs.tasks.tasks) { delete t._key; delete t._base; delete t._fbase; delete t._gone; if (t.fields && !Object.keys(t.fields).length) delete t.fields; }
    try { docs.links = await fetch('seed/links.json').then(x => x.json()); } catch {}
    if (format === 'sqlite') await DevHubDB.loadSql();
    const meta = { id: uid(), name, format, fileName: slug(name) + DevHubDB.ext(format), createdAt: now, savedAt: null, fileDirty: true };
    let handle = null;
    if (canFSA()) {
      try { handle = await window.showSaveFilePicker({ suggestedName: meta.fileName, types: [format === 'sqlite' ? { description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite', '.db'] } } : { description: 'JSON database', accept: { 'application/json': ['.json'] } }] }); meta.fileName = handle.name; }
      catch (x) { if (x.name === 'AbortError') return false; handle = null; }
    }
    activateOffline(meta, docs, handle);
    const n = docs.tasks.tasks.length, done = docs.tasks.tasks.filter(t => t.status === 'done').length;
    if (handle) await saveOffline();
    toast(`Imported ${n} task${n === 1 ? '' : 's'} (${done} done) into “${name}”${handle ? '' : ' — press Save file to keep a copy'}`);
    location.hash = next || 'tasks';
    return true;
  }
  const isDevHubError = e => /isn’t a DevHub database|isn’t valid JSON or SQLite/.test(e.message);

  async function openDbFile(file, handle, next) {
    let r;
    try { r = await DevHubDB.decode(file); }
    catch (e) { if (isDevHubError(e)) return openCustomFile(file, handle, next); throw e; }
    const now = new Date().toISOString();
    activateOffline({ id: uid(), name: r.name, format: r.format, fileName: file.name, createdAt: r.createdAt || now, savedAt: now, fileDirty: false }, r.docs, handle);
    const n = r.docs.tasks.tasks.filter(t => !t.deleted).length;
    toast(`Opened “${r.name}” · ${n} task${n === 1 ? '' : 's'}`);
    location.hash = next || 'tasks';
  }
  async function pickDbFile(input) {
    if (canFSA()) {
      let h; try { [h] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false }); } catch (e) { if (e.name === 'AbortError') return null; throw e; }
      return { file: await h.getFile(), handle: h };
    }
    return new Promise(resolve => { input.value = ''; input.onchange = () => resolve(input.files[0] ? { file: input.files[0], handle: null } : null); input.click(); });
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-save-db]')) { e.preventDefault(); saveOffline(); } });

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

  // ---------- data migrator: merge .db / .json / .xml into an existing .db / .json / .xml ----------
  const MIG_ACCEPT = '.db,.db3,.sqlite,.sqlite3,.s3db,.sl3,.json,.xml,application/json,application/xml,text/xml,application/vnd.sqlite3,application/x-sqlite3';
  const MIG_KIND = { sqlite: 'SQLite database', json: 'JSON', xml: 'XML' };
  const MIG_MODES = { upsert: 'Update matching records, add the rest', 'insert-new': 'Add only records that aren’t there yet', append: 'Add every record', replace: 'Replace everything in the target collection' };
  const migNorm = s => String(s).replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const migSing = s => migNorm(s).replace(/(ies)$/, 'y').replace(/(ses|xes)$/, s => s.slice(0, -2)).replace(/s$/, '');
  // Field names that usually mean the same thing
  const FIELD_SYN = [
    ['notes', 'note', 'description', 'desc', 'details', 'body', 'comment', 'comments', 'remarks'],
    ['due', 'duedate', 'deadline', 'dueon', 'dueby', 'duedt', 'targetdate', 'enddate'],
    ['createdat', 'created', 'createdon', 'creationdate', 'datecreated', 'createtime', 'createddate'],
    ['updatedat', 'updated', 'modified', 'lastmodified', 'modifiedat', 'updatetime', 'modifiedon', 'updatedon', 'lastupdated'],
    ['completedat', 'completedon', 'donedate', 'finishedat', 'closedat', 'completiondate', 'dateclosed'],
    ['title', 'name', 'subject', 'summary', 'task', 'taskname'],
    ['project', 'projectid', 'projectname'],
    ['tags', 'labels', 'categories', 'keywords'],
    ['priority', 'prio', 'importance', 'severity'],
    ['status', 'state', 'stage'],
    ['estimate', 'estimatemin', 'estimateminutes', 'effort'],
    ['url', 'link', 'href', 'website']
  ];
  // Values that usually mean the same thing (matched against a target choice's value or label)
  const VALUE_SYN = [
    ['done', 'completed', 'complete', 'closed', 'finished', 'resolved', 'fixed', 'shipped', 'delivered', 'yes', 'true'],
    ['doing', 'inprogress', 'started', 'active', 'ongoing', 'wip', 'working', 'inreview', 'review', 'underway'],
    ['todo', 'notstarted', 'open', 'new', 'pending', 'backlog', 'planned', 'tobedone', 'notdone', 'no', 'false'],
    ['urgent', 'critical', 'highest', 'blocker', 'p0', 'veryhigh'],
    ['high', 'important', 'p1', 'major'],
    ['medium', 'med', 'normal', 'moderate', 'default', 'p2', 'average'],
    ['low', 'lowest', 'minor', 'trivial', 'p3', 'p4']
  ];
  const synMatch = (groups, a, b) => { a = migNorm(a); b = migNorm(b); return a === b || groups.some(g => g.includes(a) && g.includes(b)); };
  const choicesOf = col => col ? col.choices ? col.choices.map(([v, l]) => ({ v, l })) : col.values ? col.values.map(x => ({ v: x.v, l: x.v })) : null : null;
  function autoValue(src, choices) {
    if (!choices) return undefined;
    const hit = choices.find(c => migNorm(c.v) === migNorm(src) || migNorm(c.l) === migNorm(src)) || choices.find(c => synMatch(VALUE_SYN, src, c.v) || synMatch(VALUE_SYN, src, c.l));
    return hit ? hit.v : undefined;
  }

  function migratorTool() {
    return el => {
      el.innerHTML = `<div class="mig-grid">
          <section><h3 class="mig-h"><span class="mig-n">1</span> Source <span class="hint">— the data to move</span></h3><div data-side="src"></div><p class="hint" data-info="src"></p></section>
          <section><h3 class="mig-h"><span class="mig-n">2</span> Target <span class="hint">— the existing file to add it to</span></h3><div data-side="dst"></div>
            <p class="hint mig-new">No target yet? Start an empty one: <button type="button" class="ghost" data-new="sqlite">SQLite</button><button type="button" class="ghost" data-new="json">JSON</button><button type="button" class="ghost" data-new="xml">XML</button></p>
            <p class="hint" data-info="dst"></p></section></div>
        <div data-map hidden></div>
        <div data-prog hidden></div><div data-result hidden></div>`;
      const files = { src: null, dst: null }, info = { src: null, dst: null };
      const mapEl = $('[data-map]', el), resEl = $('[data-result]', el);
      let busy = false, pending = false;

      async function inspectAll() {
        if (busy) { pending = true; return; }
        mapEl.hidden = true; resEl.hidden = true;
        if (!files.src || !files.dst) return;
        busy = true;
        try {
          for (const side of ['src', 'dst']) {
            const f = files[side]; if (info[side] && info[side].file === f) continue;
            const r = await runJob({ kind: 'inspect', source: f.blob, name: f.name }, progressUI($('[data-prog]', el)));
            info[side] = { ...r.info, file: f };
            const i = info[side];
            $(`[data-info="${side}"]`, el).textContent = `${i.profile === 'devhub' ? 'DevHub database' : MIG_KIND[i.kind]}${i.profile === 'devhub' ? ` (${MIG_KIND[i.kind]})` : ''} · ${i.collections.length ? i.collections.map(c => `${c.label} (${c.count.toLocaleString()})`).join(', ') : 'empty — new collections will be created'}`;
          }
          renderMap();
        } catch (e) { mapEl.hidden = false; mapEl.innerHTML = `<div class="out err">${esc(e.message)}</div>`; }
        $('[data-prog]', el).hidden = true; busy = false;
        if (pending) { pending = false; inspectAll(); }
      }
      const pick = side => x => { files[side] = x; info[side] = null; $(`[data-info="${side}"]`, el).textContent = ''; inspectAll(); };
      fileSource($('[data-side="src"]', el), { accept: MIG_ACCEPT, onFile: pick('src') });
      const dstSrc = fileSource($('[data-side="dst"]', el), { accept: MIG_ACCEPT, onFile: pick('dst') });
      el.querySelectorAll('[data-new]').forEach(b => b.onclick = () => {
        const k = b.dataset.new, name = 'migrated.' + (k === 'sqlite' ? 'db' : k);
        dstSrc.clear(); pick('dst')({ blob: new Blob([], { type: 'application/octet-stream' }), name, size: 0 });
      });

      function renderMap() {
        const S = info.src, D = info.dst;
        if (!S.collections.length) { mapEl.hidden = false; mapEl.innerHTML = `<div class="out err">No tables or lists of records were found in ${esc(S.name)}.</div>`; return; }
        const noun = D.kind === 'sqlite' ? 'table' : 'collection', fnoun = D.kind === 'sqlite' ? 'column' : D.kind === 'xml' ? 'element' : 'field';
        const bestDst = sc => {
          const hit = D.collections.find(c => migNorm(c.name) === migNorm(sc.name) && c.devhub) || D.collections.find(c => migNorm(c.name) === migNorm(sc.name)) || D.collections.find(c => migSing(c.name) === migSing(sc.name));
          if (hit) return hit.id;
          if (S.collections.length === 1 && D.collections.length === 1) return D.collections[0].id;
          return D.rootArray && D.collections.length ? D.collections[0].id : 'new';
        };
        mapEl.hidden = false;
        mapEl.innerHTML = `<h3 class="mig-h"><span class="mig-n">3</span> Map ${S.collections.length === 1 ? 'the data' : 'each source ' + (S.kind === 'sqlite' ? 'table' : 'collection')} <span class="hint">— check the fields and values, then preview</span></h3>
          ${D.profile === 'devhub' ? '<p class="hint mig-dh">The target is a <b>DevHub database</b>: its task fields and allowed values (status To do / In progress / Done, priority Urgent–Low) are listed even when it’s empty. Project names become DevHub projects, and dates are converted.</p>' : ''}
          <div class="row mig-global"><label class="check-line"><input type="checkbox" data-addnew checked> Add ${fnoun}s the target doesn’t have yet</label>
          ${D.kind === 'json' ? '<label class="check-line"><input type="checkbox" data-parsejson checked> Turn JSON text (e.g. from SQLite) into real objects and arrays</label>' : ''}
          ${S.kind === 'xml' ? '<label class="check-line"><input type="checkbox" data-infer checked> Detect numbers and true/false in XML values</label>' : ''}</div>
          ${S.collections.map((sc, i) => `<div class="mig-col" data-i="${i}">
            <label class="check-line mig-title"><input type="checkbox" data-inc ${sc.count ? 'checked' : ''}> <b>${esc(sc.label)}</b> <span class="hint">${sc.count.toLocaleString()} records · ${sc.columns.length} fields</span></label>
            <div class="mig-opts opt-grid">
              <label>Into ${noun}<select data-dst>${D.rootArray ? '' : `<option value="new">+ New ${noun}</option>`}${D.collections.map(c => `<option value="${esc(c.id)}">${esc(c.label)} (${c.count.toLocaleString()})</option>`).join('')}</select></label>
              <label data-nn>New ${noun} name<input data-newname value="${esc(sc.name)}"></label>
              <label>How<select data-mode>${Object.entries(MIG_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
              <label data-k>Match source field<select data-skey>${sc.columns.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></label>
              <label data-k>…to target ${fnoun}<select data-dkey></select></label>
            </div>
            <details class="mig-fields" open><summary></summary><p class="hint mig-warn" data-warn hidden></p><div class="table-wrap"><table><thead><tr><th>Source field</th><th>→ Target ${fnoun}</th><th>Values</th></tr></thead><tbody></tbody></table></div></details>
            <details class="mig-sample"><summary>Sample: first ${Math.min(3, sc.sample.length)} records after mapping</summary><div class="table-wrap" data-sample></div></details>
          </div>`).join('')}
          <div class="row action-bar"><button class="primary" data-go>Preview migration</button><span class="hint">Nothing is written until you create the file.</span></div>`;

        mapEl.querySelectorAll('.mig-col').forEach(box => {
          const sc = S.collections[+box.dataset.i], dsel = $('[data-dst]', box);
          dsel.value = bestDst(sc); if (!dsel.value) dsel.selectedIndex = 0;
          const target = () => D.collections.find(c => c.id === dsel.value) || null;
          const upd = () => {
            const dc = target(), isNew = !dc, addNew = $('[data-addnew]', mapEl).checked;
            $('[data-nn]', box).hidden = !isNew;
            const tcols = dc ? dc.columns : [];
            const known = tcols.filter(t => t.known), matchIn = (list, name) => list.find(t => migNorm(t.name) === migNorm(name)) || list.find(t => synMatch(FIELD_SYN, name, t.name));
            const matchCol = name => (known.length && matchIn(known, name)) || matchIn(tcols, name); // prefer the target's real (DevHub) fields over stray ones
            // key
            const dkey = $('[data-dkey]', box), skey = $('[data-skey]', box);
            const keyCols = isNew ? sc.columns.map(c => c.name) : tcols.map(c => c.name);
            dkey.innerHTML = keyCols.map(c => `<option>${esc(c)}</option>`).join('');
            const tk = isNew ? sc.key : dc.key, sk = sc.key;
            let pairS = null, pairD = null;
            if (tk) { pairD = tk; pairS = sc.columns.find(c => migNorm(c.name) === migNorm(tk))?.name || (isNew ? tk : sk); }
            else if (sk) { pairS = sk; pairD = keyCols.find(c => migNorm(c) === migNorm(sk)) || null; }
            if (pairS && pairD) { skey.value = pairS; dkey.value = pairD; }
            $('[data-mode]', box).value = pairS && pairD ? 'upsert' : 'append';
            // fields: each target used once by default
            const used = new Set();
            const tb = $('tbody', box);
            tb.innerHTML = sc.columns.map((c, ci) => {
              let m = matchCol(c.name); if (m && used.has(m.name)) m = null; if (m) used.add(m.name);
              const v = m ? m.name : isNew || addNew ? '__new' : '__skip';
              const opts = `<option value="__new">+ New ${fnoun} “${esc(c.name.replace(/^[@#]/, ''))}”</option><option value="__custom">Custom name…</option><option value="__skip">Skip</option>${tcols.length ? `<optgroup label="Target ${fnoun}s">${tcols.map(t => `<option value="${esc(t.name)}" ${t.name === v ? 'selected' : ''}>${esc(t.name)}${t.hint ? ` — ${esc(t.hint)}` : t.type ? ` · ${esc(String(t.type).toLowerCase())}` : ''}</option>`).join('')}</optgroup>` : ''}`;
              return `<tr data-ci="${ci}" data-from="${esc(c.name)}"><td>${esc(c.name)}${c.type ? ` <span class="hint">${esc(String(c.type).toLowerCase())}</span>` : ''}</td>
                <td><select data-to aria-label="Target for ${esc(c.name)}">${opts.replace(`value="${v}"`, `value="${v}" selected`)}</select><input data-custom placeholder="Target ${fnoun} name" hidden></td>
                <td>${c.values ? `<button type="button" class="ghost mig-vbtn" data-vtoggle></button>` : '<span class="hint">—</span>'}</td></tr>
                ${c.values ? `<tr class="mig-vrow" data-vrow="${ci}" hidden><td colspan="3"><div class="mig-vals"></div></td></tr>` : ''}`;
            }).join('');
            tb.querySelectorAll('tr[data-ci]').forEach(tr => {
              const sel = $('[data-to]', tr), inp = $('[data-custom]', tr);
              sel.onchange = () => { inp.hidden = sel.value !== '__custom'; if (!inp.hidden) inp.focus(); buildValues(tr, true); refresh(); };
              inp.oninput = refresh;
              const vt = $('[data-vtoggle]', tr); if (vt) vt.onclick = () => { const row = $(`[data-vrow="${tr.dataset.ci}"]`, box); row.hidden = !row.hidden; };
              buildValues(tr, true);
            });
            modeUI(); refresh();
          };
          // value mapping editor for one field
          function buildValues(tr, reset) {
            const c = sc.columns[+tr.dataset.ci]; if (!c.values) return;
            const tname = $('[data-to]', tr).value, tcol = (target()?.columns || []).find(t => t.name === tname);
            const choices = choicesOf(tcol), strict = !!(tcol && tcol.choices);
            const wrap = $(`[data-vrow="${tr.dataset.ci}"] .mig-vals`, box);
            wrap.innerHTML = `<p class="hint">${strict ? `Target only accepts: ${tcol.choices.map(([v, l]) => `${esc(l)}`).join(', ')}.` : choices ? 'Values already in the target are listed; pick one or keep the source value.' : 'Change a value or keep it as it is.'}</p>
              <table class="mig-vtable"><tbody>${c.values.map((x, vi) => { const auto = reset ? autoValue(x.v, choices) : undefined;
                return `<tr data-v="${esc(x.v)}"><td><code>${esc(x.v === '' ? '(empty)' : x.v)}</code> <span class="hint">×${x.n}</span></td><td>→</td>
                <td><select data-vm><option value="__keep">Keep “${esc(x.v)}”</option>${choices ? choices.map(ch => `<option value="${esc(JSON.stringify(ch.v))}" ${auto !== undefined && ch.v === auto ? 'selected' : ''}>${esc(ch.l)}${ch.l !== String(ch.v) ? ` (${esc(ch.v)})` : ''}</option>`).join('') : ''}<option value="__custom">Other…</option></select><input data-vc placeholder="New value" hidden></td></tr>`; }).join('')}</tbody></table>`;
            wrap.dataset.strict = strict ? '1' : '';
            wrap.querySelectorAll('[data-vm]').forEach(s => s.onchange = () => { const i = s.nextElementSibling; i.hidden = s.value !== '__custom'; if (!i.hidden) i.focus(); refresh(); });
            wrap.querySelectorAll('[data-vc]').forEach(i => i.oninput = refresh);
          }
          const modeUI = () => { const m = $('[data-mode]', box).value; box.querySelectorAll('[data-k]').forEach(n => n.hidden = !(m === 'upsert' || m === 'insert-new')); };
          // summary, warnings and the live sample
          function refresh() {
            const plan = collect(box);
            const nNew = plan.cols.filter(x => x.kind === 'new' || x.kind === 'custom').length, nSkip = plan.cols.filter(x => !x.to).length, nMap = plan.cols.length - nNew - nSkip;
            $('.mig-fields > summary', box).textContent = `Fields: ${nMap} matched · ${nNew} new · ${nSkip} skipped`;
            const warn = [];
            box.querySelectorAll('tr[data-ci]').forEach(tr => {
              const vt = $('[data-vtoggle]', tr); if (!vt) return;
              const wrap = $(`[data-vrow="${tr.dataset.ci}"] .mig-vals`, box), sels = [...wrap.querySelectorAll('[data-vm]')];
              const changed = sels.filter(s => s.value !== '__keep').length, strict = wrap.dataset.strict && $('[data-to]', tr).value !== '__skip';
              const bad = strict ? sels.filter(s => s.value === '__keep' || s.value === '__custom') : [];
              sels.forEach(s => s.classList.toggle('mig-bad-sel', bad.includes(s)));
              vt.textContent = `${sels.length} value${sels.length === 1 ? '' : 's'}${changed ? ` · ${changed} mapped` : ''}${bad.length ? ` · ${bad.length} to fix` : ''}`;
              vt.classList.toggle('mig-bad', !!bad.length);
              if (bad.length) warn.push(`${tr.dataset.from}: ${bad.map(s => `“${s.closest('tr').dataset.v}”`).join(', ')} ${bad.length === 1 ? 'isn’t an allowed value' : 'aren’t allowed values'} in the target — map ${bad.length === 1 ? 'it' : 'them'}, or DevHub will use its default.`);
            });
            const w = $('[data-warn]', box); w.hidden = !warn.length; w.textContent = warn.join(' ');
            const cols = plan.cols.filter(x => x.to), rows = sc.sample.slice(0, 3);
            $('[data-sample]', box).innerHTML = cols.length ? `<table><thead><tr>${cols.map(x => `<th>${esc(x.to)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(x => { let v = r[x.from]; if (x.values && Object.prototype.hasOwnProperty.call(x.values, v)) v = String(x.values[v]); return `<td>${esc(v.length > 60 ? v.slice(0, 60) + '…' : v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>` : '<p class="hint">No fields selected.</p>';
          }
          box.upd = upd; box.refresh = refresh;
          dsel.onchange = upd; $('[data-mode]', box).onchange = modeUI;
          $('[data-inc]', box).onchange = e => box.classList.toggle('off', !e.target.checked);
          box.classList.toggle('off', !sc.count);
          upd();
        });
        $('[data-addnew]', mapEl).onchange = () => mapEl.querySelectorAll('.mig-col').forEach(b => b.upd());
        $('[data-go]', mapEl).onclick = () => run(true);
      }

      function collect(b) {
        const S = info.src, D = info.dst, sc = S.collections[+b.dataset.i];
        const dst = $('[data-dst]', b).value, mode = $('[data-mode]', b).value;
        const cols = [...b.querySelectorAll('tbody tr[data-ci]')].map(tr => {
          const v = $('[data-to]', tr).value, from = tr.dataset.from;
          const to = v === '__skip' ? null : v === '__new' ? (D.kind === 'xml' ? from : from.replace(/^[@#]/, '')) : v === '__custom' ? ($('[data-custom]', tr).value.trim() || null) : v;
          const out = { from, to, kind: v === '__new' ? 'new' : v === '__custom' ? 'custom' : v === '__skip' ? 'skip' : 'map' };
          const vrow = $(`[data-vrow="${tr.dataset.ci}"]`, b);
          if (vrow) { const values = {}; let any = false;
            vrow.querySelectorAll('tr[data-v]').forEach(r => { const s = $('[data-vm]', r); if (s.value === '__keep') return;
              values[r.dataset.v] = s.value === '__custom' ? $('[data-vc]', r).value : JSON.parse(s.value); any = true; });
            if (any) out.values = values; }
          return out;
        });
        const skey = $('[data-skey]', b).value; let dkey = $('[data-dkey]', b).value;
        if (dst === 'new') dkey = cols.find(c => c.from === dkey)?.to || dkey;
        return { src: sc.id, dst, newName: $('[data-newname]', b).value, mode, srcKey: skey, dstKey: dkey, cols, label: sc.label };
      }

      let lastPlan = null;
      async function run(dryRun) {
        const plan = [...mapEl.querySelectorAll('.mig-col')].filter(b => $('[data-inc]', b).checked).map(collect);
        if (!plan.length) return toast('Tick at least one source collection to migrate');
        const bad = plan.find(p => (p.mode === 'upsert' || p.mode === 'insert-new') && !p.cols.some(c => c.from === p.srcKey && c.to));
        if (bad && bad.dst === 'new') return toast(`${bad.label}: the match field “${bad.srcKey}” is set to Skip`);
        const noName = plan.find(p => p.cols.some(c => c.kind === 'custom' && !c.to)); if (noName) return toast(`${noName.label}: type a name for each “Custom name” field`);
        if (!dryRun && plan.some(p => p.mode === 'replace') && !confirm('“Replace everything” removes the existing records in those target collections before adding the new ones. Continue?')) return;
        const opts = { parseJson: $('[data-parsejson]', mapEl)?.checked, inferTypes: $('[data-infer]', mapEl)?.checked };
        const go = $('[data-go]', mapEl); go.disabled = true; resEl.hidden = true;
        try {
          const r = await runJob({ kind: 'migrate', dryRun, source: files.src.blob, sourceName: files.src.name, target: files.dst.blob, targetName: files.dst.name, plan, opts }, progressUI($('[data-prog]', el)));
          lastPlan = { plan, opts };
          dryRun ? showPreview(r) : showResult(r);
        } catch (e) { resEl.hidden = false; resEl.innerHTML = `<div class="out err">${esc(e.message)}</div><p class="hint">Nothing was changed — your files are untouched.</p>`; }
        $('[data-prog]', el).hidden = true; go.disabled = false;
      }
      const reportTable = r => `<div class="table-wrap mig-report"><table><thead><tr><th>Source</th><th>Target</th><th>Add</th><th>Update</th><th>Skip</th><th>Fail</th><th>Notes</th></tr></thead><tbody>
          ${r.report.map(x => `<tr><td>${esc(x.src)}</td><td>${esc(x.dst)}</td><td>${x.inserted.toLocaleString()}</td><td>${x.updated.toLocaleString()}</td><td>${x.skipped.toLocaleString()}</td><td>${x.failed.toLocaleString()}</td><td>${esc([x.created ? 'new' : '', x.cleared ? 'replaces existing' : '', x.newColumns.length ? 'new fields: ' + x.newColumns.join(', ') : '', x.projectsCreated ? `${x.projectsCreated} new project${x.projectsCreated === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))}</td></tr>`).join('')}
          </tbody></table></div>
          ${r.report.filter(x => x.renamed).map(x => `<p class="hint">${esc(x.renamed)}</p>`).join('')}
          ${r.report.filter(x => x.errors.length).map(x => `<div class="out err">${esc(x.src)}:\n${esc(x.errors.join('\n'))}${x.failed > x.errors.length ? `\n…and ${(x.failed - x.errors.length).toLocaleString()} more` : ''}</div>`).join('')}
          ${(r.notes || []).map(n => `<p class="hint">${esc(n)}</p>`).join('')}`;
      const tot = (r, k) => r.report.reduce((a, x) => a + x[k], 0);
      function showPreview(r) {
        resEl.hidden = false;
        resEl.innerHTML = `<div class="result-head"><div><b>Preview</b> <span class="hint">— nothing written yet</span>
            <div class="hint">${tot(r, 'inserted').toLocaleString()} to add · ${tot(r, 'updated').toLocaleString()} to update · ${tot(r, 'skipped').toLocaleString()} to skip${tot(r, 'failed') ? ` · <b class="mig-bad">${tot(r, 'failed').toLocaleString()} would fail</b>` : ''}</div></div>
          <div class="row"><button class="primary" data-create>Create ${esc(files.dst.name)}</button><button data-back>Change mapping</button></div></div>
          ${reportTable(r)}
          ${r.report.map(x => { const cols = [...new Set(x.samples.flatMap(s => Object.keys(s.rec)))]; return x.samples.length ? `<p class="hint">How <b>${esc(x.src)}</b> will be written into <b>${esc(x.dst)}</b> (first ${x.samples.length} of ${(x.inserted + x.updated).toLocaleString()})</p>
            <div class="table-wrap"><table><thead><tr><th></th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${x.samples.map(s => `<tr><td><span class="chip">${s.action === 'add' ? 'add' : 'update'}</span></td>${cols.map(c => { const v = s.rec[c] ?? ''; return `<td>${esc(v.length > 80 ? v.slice(0, 80) + '…' : v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>` : ''; }).join('')}`;
        $('[data-create]', resEl).onclick = () => run(false);
        $('[data-back]', resEl).onclick = () => mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      function showResult(r) {
        const name = files.dst.name;
        resEl.hidden = false;
        resEl.innerHTML = `<div class="result-head"><div><b>${esc(name)}</b> <span class="hint">created</span>
            <div class="hint">${tot(r, 'inserted').toLocaleString()} added · ${tot(r, 'updated').toLocaleString()} updated · ${tot(r, 'skipped').toLocaleString()} skipped${tot(r, 'failed') ? ` · <b class="mig-bad">${tot(r, 'failed').toLocaleString()} failed</b>` : ''} · ${fmtBytes(files.dst.size)} → ${fmtBytes(r.blob.size)} · ${(r.ms / 1000).toFixed(1)} s</div></div>
          <div class="row"><button class="primary" data-dl>Download</button>${canShareFiles() ? '<button data-share>Share</button>' : ''}<button data-chain title="Keep working on the result, e.g. to migrate another source into it">Use as target</button></div></div>
          <p class="hint">Download saves the updated copy as <b>${esc(name)}</b> — replace your original with it. Your original file was not changed.${r.profile === 'devhub' ? ' Open it in DevHub with Tasks → Open database file.' : ''}</p>
          ${reportTable(r)}
          ${r.previews.map(p => `<p class="hint">Result: <b>${esc(p.label)}</b> — last ${Math.min(50, p.count)} of ${p.count.toLocaleString()} records</p>
            <div class="table-wrap"><table><thead><tr>${p.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${p.rows.map(row => `<tr>${row.map(v => `<td>${esc(v.length > 120 ? v.slice(0, 120) + '…' : v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}`;
        $('[data-dl]', resEl).onclick = () => saveBlob(r.blob, name).catch(e => toast(e.message));
        const sh = $('[data-share]', resEl); if (sh) sh.onclick = () => shareBlob(r.blob, name);
        $('[data-chain]', resEl).onclick = () => {
          dstSrc.clear(); files.dst = { blob: r.blob, name, size: r.blob.size }; info.dst = null;
          toast('The result is now the target'); inspectAll();
        };
      }
    };
  }

  const FILE_TOOLS = [
    ...Object.entries(FMT).map(([k, f]) => ({ id: 'fmt-' + k, group: 'Formatters', name: `${f.name} formatter`, desc: `Pretty-print${f.minify ? ' or minify' : ''} ${f.name}${k === 'js' ? ' and TypeScript/JSX' : k === 'css' ? ', SCSS and Less' : ''}. Open a file from your device or paste text.${k === 'yaml' ? ' Comments are not kept.' : ''}`, render: formatterTool(k) })),
    { id: 'migrate', group: 'Converters', name: 'Data migrator (DB / JSON / XML)', desc: 'Move records from a .db/.sqlite, .json or .xml file into an existing .db/.sqlite, .json or .xml file — any combination. Map tables, fields and values (e.g. “Completed” → Done), preview the result, then create the updated file.', render: migratorTool() },
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
  const syncLine = () => session.user || offline.meta ? `<div class="mobile-sync"><span class="ms-text">${esc($('#syncStatus')?.textContent || '')}</span>${!session.user && offline.meta ? '<button type="button" class="ghost" data-save-db hidden>Save file</button>' : ''}</div>` : '';

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
  const authShell = inner => `<div class="auth"><div class="auth-card"><div class="auth-brand"><span class="brand-mark">{ }</span><span>DevHub</span></div>${offline.meta ? `<p class="form-note">Signing in closes your offline database “${esc(offline.meta.name)}”.${offline.meta.fileDirty ? ' It has changes that aren’t saved to the file yet — <a href="#account">save it first</a>.' : ''}</p>` : ''}${inner}</div>
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
      <p class="auth-switch">New here? <a href="#register${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}">Create an account</a></p>
      <p class="auth-switch alt">Don’t want an account? <a href="#start?next=${nextRoute()}">Use DevHub offline</a></p>`);
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
      <p class="auth-switch">Already have an account? <a href="#login">Sign in</a></p>
      <p class="auth-switch alt">Don’t want an account? <a href="#start?next=${nextRoute()}">Use DevHub offline</a></p>`);
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
          <div class="row"><button id="syncNow">Sync now</button><button id="ex">Export JSON</button><button id="exq">Export SQLite</button><label class="btn" style="margin:0">Import backup<input type="file" id="im" ${accept} hidden></label></div>
          <p class="hint" style="margin-top:10px">Exports are offline databases too — open one with “Use offline” on any device. Import accepts JSON or SQLite files.</p></section>
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
    const dbMeta = { name: `${u.name || u.username}'s tasks` };
    $('#ex').onclick = async () => saveBlob(await DevHubDB.encode('json', data.docs, dbMeta), `devhub-${u.username}-${dayKey(new Date())}.json`);
    $('#exq').onclick = async () => { try { saveBlob(await DevHubDB.encode('sqlite', data.docs, dbMeta), `devhub-${u.username}-${dayKey(new Date())}.sqlite`); } catch (x) { toast(x.message); } };
    $('#im').onchange = async e => { const file = e.target.files[0]; if (!file) return;
      try { const r = await DevHubDB.decode(file);
        if (!confirm(`Replace your current tasks and links with “${r.name}”?`)) return;
        data.set('tasks', r.docs.tasks); data.set('links', r.docs.links); data.set('prefs', r.docs.prefs); data.changed(); toast('Imported ' + r.name);
      } catch (x) { toast(x.message); } e.target.value = ''; };
    $('#so').onclick = signOut;
    $('#soa').onclick = async () => { if (!confirm('Sign out on every device, including this one?')) return; try { await push(); await api('/auth/logout-all', { method: 'POST' }); } catch (x) { return toast(x.message); } const id = session.user.id; data.wipe(id); session.clear(); renderNavUser(); location.hash = 'login'; toast('Signed out on all devices'); };
    $('#del').onclick = async () => { const pw = prompt('This permanently deletes your account and data. Enter your password to confirm:'); if (!pw) return;
      try { await api('/auth/account', { method: 'DELETE', body: { password: pw } }); const id = session.user.id; data.wipe(id); session.clear(); renderNavUser(); location.hash = 'register'; toast('Your account was deleted'); } catch (x) { toast(x.message); } };
  }

  // ---------- start: choose online or offline ----------
  const ICON_CLOUD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  const ICON_DB = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7" ry="2.8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 5.5v13c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-13M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const accept = coarse ? '' : 'accept=".json,.sqlite,.sqlite3,.db,.db3,.xml,application/json,application/xml,text/xml,application/vnd.sqlite3,application/x-sqlite3"';

  function renderStart() {
    const next = nextRoute(), qs = location.hash.includes('?') ? '?' + location.hash.split('?')[1] : '';
    if (session.user || offline.meta) { location.replace('#' + next); return; }
    view().innerHTML = `<div class="start">
      <h1>How would you like to keep your tasks?</h1>
      <p class="lede">Choose one — you can switch later. The developer tools work either way, no sign-in needed.</p>
      <div class="start-grid">
        <section class="start-card">
          <div class="start-ico">${ICON_CLOUD}</div><h2>Online</h2>
          <p>Sign in and your tasks and links sync across your phone, tablet and computer.</p>
          <ul class="ticks"><li>Syncs between all your devices</li><li>Stored safely on the server</li><li class="minus">Needs an account, and internet to sync</li></ul>
          <div class="start-actions"><a class="btn primary" href="#login${qs}">Sign in</a><a class="btn" href="#register${qs}">Create account</a></div>
        </section>
        <section class="start-card">
          <div class="start-ico">${ICON_DB}</div><h2>Offline</h2>
          <p>No account. Your tasks live in a file on this device — a DevHub database, or <b>your own</b> .db, .json or .xml task file (work on it directly, or import it into DevHub).</p>
          <ul class="ticks"><li>Works without internet</li><li>You own the file — copy it, back it up, open it in other tools</li><li class="minus">No automatic sync; move the file yourself</li></ul>
          <div class="start-actions"><button class="primary" id="stNew">Create new database</button><button id="stOpen">Open database file</button></div>
          <input type="file" id="stFile" hidden ${accept}>
          <p class="form-err" id="stErr" role="alert" hidden></p>
        </section>
      </div>
      <section class="panel start-create" id="stCreate" hidden></section>
    </div>`;
    const err = $('#stErr'), panel = $('#stCreate');
    const fail = m => { err.textContent = m; err.hidden = false; };
    $('#stOpen').onclick = async () => {
      err.hidden = true;
      try { const r = await pickDbFile($('#stFile')); if (r) await openDbFile(r.file, r.handle, next); }
      catch (e) { fail(e.message); }
    };
    $('#stNew').onclick = () => {
      err.hidden = true; panel.hidden = false;
      panel.innerHTML = `<h2>Create a new database</h2><form id="stForm" novalidate>
        <label for="dbName">Database name</label><input id="dbName" name="name" value="My tasks" maxlength="60" required>
        <fieldset class="fmt"><legend>File format</legend>
          <label class="fmt-opt"><input type="radio" name="format" value="json" checked><span><b>JSON</b><small>Readable text. Easy to look inside, edit or keep in Git.</small></span></label>
          <label class="fmt-opt"><input type="radio" name="format" value="sqlite"><span><b>SQLite</b><small>A real database. Query it with DB Browser for SQLite, sqlite3 or DBeaver.</small></span></label>
        </fieldset>
        <p class="hint">${canFSA() ? 'Next you’ll choose where to save the file. After that, every change is saved into it automatically.' : 'While you work, your database is kept in this browser. Tap “Save file” any time to save a copy — to Downloads on a computer, or to Files on a phone or tablet.'}</p>
        <p class="form-err" role="alert" hidden></p>
        <div class="row"><button class="primary">Create database</button><button type="button" class="ghost" id="stCancel">Cancel</button></div></form>`;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#dbName').focus(); $('#dbName').select();
      $('#stCancel').onclick = () => { panel.hidden = true; };
      $('#stForm').onsubmit = async e => {
        e.preventDefault();
        const f = e.target, name = f.name.value.trim(), format = f.format.value, ferr = $('.form-err', f), btn = $('button.primary', f);
        if (!name) { fieldErrors(f, { name: 'Give your database a name.' }); return; }
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
          const docs = DevHubDB.emptyDocs();
          try { docs.links = await fetch('seed/links.json').then(r => r.json()); } catch {}
          if (format === 'sqlite') await DevHubDB.loadSql();
          const now = new Date().toISOString();
          const meta = { id: uid(), name, format, fileName: slug(name) + DevHubDB.ext(format), createdAt: now, savedAt: null, fileDirty: true };
          let handle = null;
          if (canFSA()) {
            try { handle = await window.showSaveFilePicker({ suggestedName: meta.fileName, types: [format === 'sqlite' ? { description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite', '.db'] } } : { description: 'JSON database', accept: { 'application/json': ['.json'] } }] }); meta.fileName = handle.name; }
            catch (x) { if (x.name === 'AbortError') { btn.disabled = false; btn.textContent = 'Create database'; return; } handle = null; }
          }
          activateOffline(meta, docs, handle);
          if (handle && await saveOffline()) { toast(`Created “${name}” — changes save to ${meta.fileName} automatically`); location.hash = next; return; }
          panel.innerHTML = `<div class="ready"><span class="ready-ico" aria-hidden="true">✓</span><div><h2>“${esc(name)}” is ready</h2>
            <p>Your database is kept in this browser, so nothing is lost if you close the page. Save the file now to have a copy on your device, or start adding tasks and save later.</p>
            <div class="row"><button class="primary" id="stGo">Continue to tasks</button><button id="stDl">Save file now</button></div></div></div>`;
          $('#stGo').onclick = () => location.hash = next;
          $('#stDl').onclick = () => saveOffline();
          $('#stGo').focus();
        } catch (x) { ferr.textContent = x.message; ferr.hidden = false; btn.disabled = false; btn.textContent = 'Create database'; }
      };
    };
  }

  // ---------- offline database page ----------
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function renderOfflineDb() {
    const m = offline.meta, t = data.get('tasks') || {}, tasks = (t.tasks || []).filter(x => !x.deleted), links = (data.get('links') || []).filter(x => !x.deleted);
    const A = m.adapter, R = A && A.mapping.roles, roleName = Object.fromEntries(DevHubAdapter.ROLES.map(([k, l]) => [k, l]));
    view().innerHTML = `${syncLine()}<h1>Offline database</h1><p class="lede">Your tasks and links are stored in a file on this device. No account needed.</p>
      <div class="acct-grid">
        <section class="panel"><h2>${esc(m.name)}</h2>
          <dl class="kv2"><dt>Format</dt><dd>${A ? `Your own ${m.format === 'sqlite' ? 'SQLite' : m.format.toUpperCase()} file · tasks from <b>${esc(A.mapping.collection.replace(/^t:|^p:/, '').replace(/[[\]"]/g, '').replace(/,/g, ' › '))}</b>` : m.format === 'sqlite' ? 'SQLite' : 'JSON'}</dd><dt>File</dt><dd class="mono">${esc(m.fileName)}</dd>
            ${A ? `<dt>Fields</dt><dd>${Object.entries(R).filter(([, v]) => v).map(([k, v]) => `${esc(roleName[k])} ← <span class="mono">${esc(v)}</span>`).join(' · ')}${A.extraFields.length ? ` · also shown: <span class="mono">${esc(A.extraFields.join(', '))}</span>` : ''}</dd>` : ''}
            <dt>Saving</dt><dd>${offline.handle ? 'Automatic — every change is written to the file' : 'Kept in this browser; press Save file to write a copy to your device'}</dd>
            <dt>Last saved</dt><dd>${m.savedAt ? new Date(m.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not saved to a file yet'}</dd>
            <dt>Contents</dt><dd>${plural(tasks.length, 'task')} · ${plural((t.projects || []).filter(p => !p.deleted).length, 'project')} · ${plural(links.length, 'link')}</dd></dl>
          <div class="row" style="margin-top:14px"><button class="primary" id="dbSave">${offline.handle ? 'Save now' : 'Save file'}</button>${A ? '<button id="dbRemap">Change field mapping</button><button id="dbConvert">Import into a DevHub database</button>' : ''}</div>
          ${A ? '<p class="hint" style="margin-top:10px">Changes are saved back into your file in its own layout — only the fields you change are written. Subtasks, timers and repeat rules your file has no place for are kept on this device. Tool store links aren’t stored in your file.</p>' : ''}
          ${offline.handle ? '' : '<p class="hint" style="margin-top:10px">Each save downloads the whole database. Your browser may add a number to the name (for example “my-tasks (1).json”) — open the newest one next time.</p>'}
        </section>
        <section class="panel"><h2>Download a copy</h2><p class="hint">${A ? 'Save a copy as a DevHub database (all DevHub features, stored in the file).' : 'Both formats hold exactly the same data, so you can convert any time.'}</p>
          <div class="row"><button id="dlJson">Download as JSON</button><button id="dlSqlite">Download as SQLite</button></div>
          <p class="hint" style="margin-top:12px">Want to move this data online? Sign in, then use Account → Import backup with one of these files.</p></section>
        <section class="panel"><h2>Switch database</h2>
          <div class="row"><button id="dbOpen">Open another file</button><button id="dbNew">Create new database</button></div><input type="file" id="dbFile" hidden ${accept}>
          <h2 style="margin-top:22px">Use online instead</h2><p class="hint">Close this database and sign in to sync across devices.</p>
          <button id="dbOnline">Close and sign in</button></section>
      </div>`;
    offlineStatus();
    $('#dbSave').onclick = () => saveOffline().then(ok => { if (ok) { toast('Database saved'); renderOfflineDb(); } });
    $('#dlJson').onclick = () => saveOffline({ as: 'json' });
    const remapAs = mode => async () => {
      if (m.fileDirty && !(await saveOffline())) return;
      const src = await idb.get('offline-source'); if (!src) return toast('Open the file again to change its mapping');
      openCustomFile(new File([src], m.fileName, { type: src.type }), offline.handle, 'tasks', { remap: mode }).catch(e => toast(e.message));
    };
    const rm = $('#dbRemap'); if (rm) rm.onclick = remapAs(true);
    const cv = $('#dbConvert'); if (cv) cv.onclick = remapAs('import');
    $('#dlSqlite').onclick = () => saveOffline({ as: 'sqlite' });
    $('#dbOpen').onclick = async () => {
      let r; try { r = await pickDbFile($('#dbFile')); } catch (e) { return toast(e.message); }
      if (!r) return;
      try { await DevHubDB.decode(r.file); } catch (e) { if (!isDevHubError(e)) return toast(e.message); }
      if (await closeOffline()) openDbFile(r.file, r.handle, 'tasks').catch(e => toast(e.message));
    };
    $('#dbNew').onclick = async () => { if (await closeOffline()) { location.hash = 'start?next=tasks'; setTimeout(() => $('#stNew')?.click(), 50); } };
    $('#dbOnline').onclick = async () => { if (await closeOffline()) location.hash = 'login?next=tasks'; };
  }

  // ---------- mapping screen for your own file ----------
  function renderMapFile() {
    const P = pendingCustom;
    if (!P) { location.replace(offline.meta ? '#tasks' : '#start?next=tasks'); return; }
    const A = DevHubAdapter, info = P.info;
    let m = P.mapping;
    const col = () => info.collections.find(c => c.id === m.collection);
    const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
    function draw() {
      const c = col(), colOpts = sel => opt('', '— not in my file —', !sel) + c.columns.map(x => opt(x.name, x.name, x.name === sel)).join('');
      const vals = n => (c.columns.find(x => x.name === n) || {}).values;
      const mappedCols = new Set([m.key, ...Object.values(m.roles)].filter(Boolean));
      const extra = c.columns.filter(x => !mappedCols.has(x.name)).map(x => x.name);
      const valueTable = (role, map, choices) => { const v = vals(m.roles[role]); if (!m.roles[role]) return ''; if (!v) return `<p class="hint">“${esc(m.roles[role])}” has too many different values to map one by one.</p>`;
        return `<div class="table-wrap mf-vals"><table><thead><tr><th>In your file</th><th>Tasks</th><th>In DevHub</th></tr></thead><tbody>${v.map(x => `<tr><td><code>${esc(x.s === '' ? '(empty)' : x.s)}</code></td><td>${x.n}</td><td><select data-vmap="${role}" data-v="${esc(x.s)}">${choices.map(([k, l]) => opt(k, l, String(map[x.s]) === String(k))).join('')}</select></td></tr>`).join('')}</tbody></table></div>`; };
      view().innerHTML = `<h1>Set up your file</h1>
        <p class="lede"><b>${esc(P.file.name)}</b> isn’t a DevHub database — that’s fine. Choose how to use it, then tell DevHub which of your fields mean what.</p>
        <section class="panel mf">
          <fieldset class="fmt mf-mode"><legend>How do you want to use this file?</legend>
            <label class="fmt-opt"><input type="radio" name="mfMode" value="adapt" ${P.mode !== 'import' ? 'checked' : ''}><span><b>Work on my file directly</b><small>The tracker adapts to your fields and your own words, and saves changes back into ${esc(P.file.name)} in its own layout.</small></span></label>
            <label class="fmt-opt"><input type="radio" name="mfMode" value="import" ${P.mode === 'import' ? 'checked' : ''}><span><b>Import into a DevHub database</b><small>Copies the tasks into a new standard DevHub file, with every DevHub feature stored in the file. ${esc(P.file.name)} isn’t changed.</small></span></label>
          </fieldset>
          <div class="opt-grid mf-imp" ${P.mode === 'import' ? '' : 'hidden'}>
            <label>New database name<input id="mfName" value="${esc(P.impName)}" maxlength="60"></label>
            <label>Format<select id="mfFmt">${opt('json', 'JSON — readable text', P.impFormat === 'json')}${opt('sqlite', 'SQLite — a real database', P.impFormat === 'sqlite')}</select></label>
          </div>
          <div class="opt-grid mf-top">
            <label>Tasks are in<select id="mfCol">${info.collections.map(x => opt(x.id, `${x.label} (${x.count} records)`, x.id === m.collection)).join('')}</select></label>
            <label>Unique id<select id="mfKey">${opt('', info.kind === 'sqlite' ? '— row id —' : '— row position —', !m.key)}${c.columns.map(x => opt(x.name, x.name, x.name === m.key)).join('')}</select></label>
          </div>
          <h2>Fields</h2>
          <div class="table-wrap"><table class="mf-roles"><thead><tr><th>DevHub</th><th>Your field</th><th>Example</th></tr></thead><tbody>
            ${A.ROLES.map(([k, l]) => { const ex = (c.columns.find(x => x.name === m.roles[k]) || {}).sample || []; return `<tr><td><b>${esc(l)}</b>${k === 'title' ? ' <span class="hint">required</span>' : ''}</td><td><select data-role="${k}">${colOpts(m.roles[k])}</select></td><td class="hint">${esc(ex.slice(0, 2).join(' · ').slice(0, 80))}</td></tr>`; }).join('')}
          </tbody></table></div>
          ${m.roles.status ? `<h2>Status values</h2><p class="hint">Which of your values mean to do, in progress and done.${P.mode === 'import' ? '' : ' DevHub’s board columns will use your own words.'}</p>${valueTable('status', m.statusMap, [['todo', A.STATUS_LABEL.todo], ['doing', A.STATUS_LABEL.doing], ['done', A.STATUS_LABEL.done]])}` : '<p class="hint">No status field chosen: every task starts as “To do”, and status is kept on this device only.</p>'}
          ${m.roles.priority ? `<h2>Priority values</h2>${valueTable('priority', m.prioMap, [[1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low']])}` : ''}
          <h2>Other fields</h2><p class="hint">${extra.length ? `<span class="mono">${esc(extra.join(', '))}</span> — shown and editable in each task’s details${P.mode === 'import' ? ', and kept in the DevHub database' : ', and saved back to your file'}.` : 'None — every field is mapped.'}</p>
          <p class="form-err" id="mfErr" role="alert" hidden></p>
          <div class="row action-bar"><button class="primary" id="mfGo">${P.mode === 'import' ? 'Import' : 'Open'} ${c.count} task${c.count === 1 ? '' : 's'}</button><button type="button" class="ghost" id="mfCancel">Cancel</button><span class="hint">${P.mode === 'import' ? 'The mapping is remembered on this device, so the next import is quicker.' : 'Remembered on this device: next time this file opens straight to your tasks.'}</span></div>
        </section>`;
      view().querySelectorAll('[name="mfMode"]').forEach(r => r.onchange = () => { P.mode = r.value; draw(); });
      const nm = $('#mfName'); if (nm) nm.oninput = () => { P.impName = nm.value; };
      const fm = $('#mfFmt'); if (fm) fm.onchange = () => { P.impFormat = fm.value; };
      $('#mfCol').onchange = e => { m = A.guess(info, e.target.value); draw(); };
      $('#mfKey').onchange = e => { m.key = e.target.value || null; draw(); };
      view().querySelectorAll('[data-role]').forEach(s => s.onchange = () => {
        const role = s.dataset.role, v = s.value || null;
        for (const [k, x] of Object.entries(m.roles)) if (x && x === v && k !== role) m.roles[k] = null; // one field per role
        m.roles[role] = v;
        if (role === 'status') m.statusMap = v ? A.guessStatusMap(vals(v)) : {};
        if (role === 'priority') m.prioMap = v ? A.guessPrioMap(vals(v)) : {};
        if (m.formats) delete m.formats[role];
        m.formats ||= {}; draw();
      });
      view().querySelectorAll('[data-vmap]').forEach(s => s.onchange = () => { (s.dataset.vmap === 'status' ? m.statusMap : m.prioMap)[s.dataset.v] = s.dataset.vmap === 'priority' ? +s.value : s.value; });
      $('#mfCancel').onclick = () => { pendingCustom = null; location.hash = offline.meta ? 'account' : 'start?next=tasks'; };
      $('#mfGo').onclick = async () => {
        const err = $('#mfErr'); err.hidden = true;
        if (!m.roles.title) { err.textContent = 'Choose which field holds the task title.'; err.hidden = false; return; }
        const imp = P.mode === 'import', label = b0 => b0.textContent = `${imp ? 'Import' : 'Open'} ${col().count} tasks`;
        if (imp && !P.impName.trim()) { err.textContent = 'Give the new DevHub database a name.'; err.hidden = false; return; }
        const b = $('#mfGo'); b.disabled = true; b.textContent = imp ? 'Importing…' : 'Opening…';
        try {
          m.formats ||= {}; A.finish(info, m); m.mode = P.mode; maps.save(m);
          if (offline.meta && !(await closeOffline())) { b.disabled = false; label(b); return; }
          if (imp) { if (!(await importCustom(P.file, m, P.impFormat, P.impName.trim(), P.next))) { b.disabled = false; label(b); return; } pendingCustom = null; return; }
          pendingCustom = null; await activateCustom(P.file, P.handle, m, P.next);
        } catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; b.textContent = 'Try again'; }
      };
    }
    draw();
  }

  // ---------- router ----------
  const routes = { tools: sub => renderTools(sub), links: renderLinks, account: () => offline.active() ? renderOfflineDb() : renderAccount(), login: renderLogin, register: renderRegister, start: renderStart, mapfile: renderMapFile };
  const PRIVATE = new Set(['tasks', 'links', 'account']);
  function render() {
    let [route, sub] = (location.hash.slice(1).split('?')[0] || 'tools').split('/');
    if (route === 'today' || route === 'settings') route = route === 'today' ? 'tasks' : 'account';
    if (PRIVATE.has(route) && !session.user && !offline.meta) { location.replace('#start?next=' + route); return; }
    document.querySelectorAll('.nav a[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === route || (route === 'start' && a.dataset.route === 'account')));
    document.body.dataset.route = route;
    (routes[route] || routes.tools)(sub);
    if (offline.active()) offlineStatus();
  }
  window.addEventListener('hashchange', () => { render(); view().focus({ preventScroll: true }); window.scrollTo(0, 0); });
  window.addEventListener('online', () => { if (session.user) pull(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session.user && !pushing) pull(); });
  data.listeners.add(() => { const r = document.body.dataset.route; if ((r === 'tasks' || r === 'links') && !document.querySelector('dialog[open]')) render(); });

  // Shared with tasks.js
  // What the task tracker needs to adapt to your own file (null for DevHub databases and online accounts)
  const custom = () => offline.active() && offline.meta.adapter ? offline.meta.adapter : null;
  window.DH = { $, esc, toast, uid, dayKey, addDays, store, data, session, api, routes, render, copy, saveBlob, view, syncLine, custom };

  window.addEventListener('DOMContentLoaded', () => {
    if (session.user && session.token) { data.ns = session.user.id; data.load(); }
    else {
      session.clear();
      if (offline.meta) {
        data.ns = 'offline'; data.load();
        idb.get('offline-handle').then(async h => { // reconnect to the file picked earlier (Chrome/Edge desktop)
          if (!h || !offline.meta) return;
          offline.handle = h;
          try { if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && offline.meta.fileDirty) offline.needsPermission = true; } catch {}
          offlineStatus();
        });
      }
    }
    renderNavUser();
    render();
    api('/config').then(c => { serverConfig = c; if (document.body.dataset.route === 'register') render(); }).catch(() => {});
    if (session.user) { pull(); api('/auth/me').then(r => { session.setUser(r.user); renderNavUser(); }).catch(() => {}); }
    if ('serviceWorker' in navigator && !isNative()) navigator.serviceWorker.register('sw.js').catch(console.error);
  });
})();
