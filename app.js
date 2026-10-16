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
    setUser(user) { this.user = user; try { (localStorage.getItem('devhub:token') || localStorage.getItem('devhub:bio') ? localStorage : sessionStorage).setItem('devhub:user', JSON.stringify(user)); } catch {} },
    clear() { this.token = null; this.user = null; try { ['devhub:token', 'devhub:user'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); }); } catch {} if (window.DHBio) window.DHBio.forget(); }
  };
  let serverConfig = { registration: 'open' }, configAsked = false;
  function loadConfig() { // only the register screens need it, so opening the app or the login page never wakes the server
    if (configAsked) return; configAsked = true;
    api('/config').then(c => { serverConfig = c; if (document.body.dataset.route === 'register') render(); }).catch(() => { configAsked = false; });
  }

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
  function mergeById(a = [], b = [], both) {
    const m = new Map();
    for (const x of b) m.set(x.id, x);
    for (const x of a) { const y = m.get(x.id); m.set(x.id, !y ? x : both ? both(x, y) : String(x.updatedAt || '') >= String(y.updatedAt || '') ? x : y); }
    return [...m.values()];
  }
  // Task versions: each field remembers when it last changed (fv), so an edit to one field on one device and an edit to
  // another field on another device both survive. Records without field versions (older data) fall back to newest-wins.
  const TRACKED = ['title', 'notes', 'status', 'priority', 'due', 'remind', 'project', 'tags', 'estimate', 'repeat', 'subtasks', 'spent', 'deleted'];
  function mergeTask(x, y) { // x = this device, y = the other copy
    if (x === y || canon(x) === canon(y)) return x;   // same on both sides: leave untouched, so repeated syncs settle and change nothing
    const newer = String(x.updatedAt || '') >= String(y.updatedAt || '') ? x : y;
    if (!x.fv && !y.fv) return newer;
    const at = (t, f) => (t.fv && t.fv[f]) || t.updatedAt || '';
    const out = { ...newer, fv: {} };
    for (const f of TRACKED) { const from = at(x, f) >= at(y, f) ? x : y; if (f in from) out[f] = from[f]; else delete out[f]; out.fv[f] = at(from, f); }
    const statusFrom = at(x, 'status') >= at(y, 'status') ? x : y; out.completedAt = statusFrom.completedAt ?? null; // completion follows the status that won
    out.v = Math.max(x.v || 0, y.v || 0);
    out.updatedAt = String(x.updatedAt || '') >= String(y.updatedAt || '') ? x.updatedAt : y.updatedAt;
    const seen = new Set(), hist = [...(x.hist || []), ...(y.hist || [])].filter(e => { const k = e.at + '|' + e.v + '|' + Object.keys(e.d || {}).join(); if (seen.has(k)) return false; seen.add(k); return true; });
    out.hist = hist.sort((p, q) => String(p.at).localeCompare(String(q.at))).slice(-20);
    return out;
  }
  function mergeDoc(name, local, remote) {
    if (remote == null) return local; if (local == null) return remote;
    if (name === 'links' && Array.isArray(local) && Array.isArray(remote)) return mergeById(local, remote);
    if (name === 'tasks' && local.tasks && remote.tasks) return { ...remote, ...local, settings: { ...remote.settings, ...local.settings }, tasks: mergeById(local.tasks, remote.tasks, mergeTask), projects: mergeById(local.projects, remote.projects) };
    if (name === 'prefs' && typeof local === 'object' && typeof remote === 'object' && !Array.isArray(local) && !Array.isArray(remote)) return { ...remote, ...local };
    return local;
  }

  const setStatus = (text, cls = '') => {
    const el = $('#syncStatus'); if (el) { el.textContent = text; el.className = 'sync ' + cls; }
    document.querySelectorAll('.mobile-sync .ms-text').forEach(m => m.textContent = text);
  };
  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function pull() {
    if (!session.user || !session.token) return;
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

  // Wake the (possibly sleeping) server, then sync. The app is already usable from the copy on this device.
  let waking = false, wakeRetry, lastWake = 0;
  async function wakeAndSync() {
    // The sync server (Render) is only needed for the signed-in data screens; the developer tools never contact it.
    if (!session.user || !session.token || waking || !PRIVATE.has(document.body.dataset.route)) return;
    waking = true; lastWake = Date.now(); clearTimeout(wakeRetry);
    try {
      setStatus('Connecting…', 'busy');
      let up = false;
      for (let i = 0; i < 10 && session.token; i++) {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
        try { const r = await fetch(API + '/api/health', { cache: 'no-store', signal: ctl.signal }); if (r.ok) up = true; } catch {}
        clearTimeout(to);
        if (up || !navigator.onLine) break;
        setStatus(i < 2 ? 'Waking the server… your tasks are ready on this device' : 'Server is still waking up…', 'busy');
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!session.token) return;
      if (up) { await pull(); api('/auth/me').then(r => { session.setUser(r.user); renderNavUser(); }).catch(() => {}); }
      else if (!navigator.onLine) setStatus('Offline — changes saved on this device');
      else { setStatus('Server is asleep — changes saved on this device'); wakeRetry = setTimeout(wakeAndSync, 60000); }
    } finally { waking = false; }
  }
  // Fingerprint unlock: the token comes out of the Keystore, the local data opens first, the server is contacted last
  function unlockApp(token) {
    session.token = token; data.ns = session.user.id; data.load(); autoBackup.load();
    renderNavUser(); render(); wakeAndSync();
  }
  function relockApp() { session.token = null; clearTimeout(pushTimer); clearTimeout(wakeRetry); document.querySelectorAll('dialog[open]').forEach(d => d.close()); }

  let pushing = false, pushTimer;
  async function push() {
    if (!session.user || !session.token || pushing) return;
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
      setStatus(`Saved ${stamp()}`, 'ok'); autoBackup.schedule();
    } catch (e) { setStatus(e.offline ? 'Offline — changes saved on this device' : 'Not saved — ' + e.message, e.offline ? '' : 'err'); }
    finally { pushing = false; }
  }
  function schedulePush() { if (offline.active()) return markOfflineDirty(); setStatus('Unsaved changes…', 'busy'); clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }

  function startSession(token, user, remember) {
    let carried = null;   // tasks, projects and links from the offline database this device was using
    if (offline.meta) {
      carried = {}; DOCS.forEach(n => { carried[n] = store.get(`devhub:u:offline:${n}`, null); });
      clearTimeout(offline.timer); data.wipe('offline'); offline.setMeta(null); offline.handle = null; idb.del('offline-handle');
    }
    session.save(token, user, remember);
    data.ns = user.id; data.load();
    if (carried) { // add, never replace: both sets of tasks end up in the account, the newest edit of any shared task wins
      let added = 0;
      for (const n of DOCS) {
        if (carried[n] == null) continue;
        const before = n === 'tasks' && data.docs.tasks ? new Set(data.docs.tasks.tasks.map(t => t.id)) : null;
        data.docs[n] = n === 'prefs' && data.docs[n] != null ? data.docs[n] : mergeDoc(n, carried[n], data.docs[n]);
        data.dirty[n] = true;
        if (n === 'tasks') added = (data.docs.tasks.tasks || []).filter(t => !t.deleted && !(before && before.has(t.id))).length;
      }
      data.persist();
      if (added) setTimeout(() => toast(`${added} task${added === 1 ? '' : 's'} from your offline database added to your account`), 600);
    }
    renderNavUser(); pull(); autoBackup.load();
    setTimeout(() => window.DHBio && window.DHBio.offer(), 1500);
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
    meta: store.get('devhub:offline', null), handle: null, saving: false, needsPermission: false, writeFailed: false, timer: null,
    active() { return !session.user && !!this.meta; },
    setMeta(m) { this.meta = m; m ? store.set('devhub:offline', m) : store.del('devhub:offline'); }
  };
  const FILE_TYPES = [{ description: 'Task database (DevHub or your own)', accept: { 'application/json': ['.json'], 'application/vnd.sqlite3': ['.sqlite', '.sqlite3', '.db', '.db3'], 'application/xml': ['.xml'] } }];
  // A File from a picker only points at the file on disk; once that file changes (another app, a sync client, our own save)
  // Chrome refuses to read it again. Always work from an in-memory copy of the bytes.
  const snapshot = async f => new File([await f.arrayBuffer()], f.name || 'file', { type: f.type || '' });
  const FILE_CHANGED = /InvalidStateError|NotReadableError|NoModificationAllowedError|state had changed|could not be read|modified/i;
  const friendlySaveError = e => FILE_CHANGED.test(`${e.name} ${e.message}`)
    ? 'the file was changed or locked by another program (for example the app that uses it, or OneDrive/Dropbox syncing it). Your changes are safe in this browser — press Save file to try again, or close the other program first.'
    : e.message;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const slug = s => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'devhub-tasks').slice(0, 40);

  // ---------- where the offline database is saved: ONE file, never copies ----------
  //  'file'    Chrome/Edge on a computer: the file you chose once, saved in place every time
  //  'device'  Android app: Documents/DevHub/<name>, overwritten on every save
  //  'browser' Firefox/Safari/phone browsers can't write into a file in place, so the database is kept in the browser;
  //            a file is only made when you press Download backup
  const hasDeviceFs = () => isNative() && !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem);
  const target = () => offline.handle ? 'file' : hasDeviceFs() ? 'device' : 'browser';
  const devicePath = m => 'DevHub/' + m.fileName;
  const whereSaved = (m, tg = target()) => tg === 'file' ? m.fileName : tg === 'device' ? `${m.deviceDir === 'DATA' ? 'DevHub app storage' : 'Documents'}/${devicePath(m)}` : 'this browser';

  function offlineStatus() {
    const m = offline.meta; if (!m || session.user) return;
    const tg = target(), when = m.savedAt ? new Date(m.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let text, cls = '';
    if (offline.saving) { text = 'Saving…'; cls = 'busy'; }
    else if (offline.needsPermission) { text = 'Press Save to reconnect the file'; cls = 'err'; }
    else if (offline.writeFailed && m.fileDirty) { text = 'Couldn’t write to the file · press Save'; cls = 'err'; }
    else if (m.fileDirty) { text = 'Saving soon…'; cls = 'busy'; }
    else text = tg === 'browser' ? 'Saved in this browser' : when ? `Saved ${when}` : 'Ready';
    setStatus(text, cls);
    document.querySelectorAll('[data-save-db]').forEach(b => b.hidden = !(offline.needsPermission || (offline.writeFailed && m.fileDirty)));
  }
  // Write a blob into the chosen file. Retries briefly and always releases a half-finished write.
  async function writeToHandle(h, blob) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      let w = null;
      try { w = await h.createWritable(); await w.write(blob); await w.close(); return; }
      catch (e) { last = e; if (w) { try { await w.abort(); } catch {} } if (!FILE_CHANGED.test(`${e.name} ${e.message}`)) throw e; await sleep(500 * (attempt + 1)); }
    }
    throw last;
  }
  const PICK_TYPES = f => f === 'sqlite' ? [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite', '.db', '.sqlite3', '.db3'] } }] : [{ description: 'JSON database', accept: { 'application/json': ['.json'] } }];
  // Android app: overwrite the same file in Documents/DevHub (falls back to the app's own storage if Documents isn't writable)
  async function writeDevice(blob, m) {
    const { Filesystem } = window.Capacitor.Plugins, CH = 3 * 1024 * 1024;
    const put = async directory => {
      for (let i = 0; i < blob.size || i === 0; i += CH) {
        const data = await blobToBase64(blob.slice(i, i + CH));
        await (i === 0 ? Filesystem.writeFile({ path: devicePath(m), data, directory, recursive: true }) : Filesystem.appendFile({ path: devicePath(m), data, directory }));
        if (!blob.size) break;
      }
    };
    try { await put(m.deviceDir || 'DOCUMENTS'); m.deviceDir ||= 'DOCUMENTS'; }
    catch (e) { if (m.deviceDir === 'DATA') throw e; await put('DATA'); m.deviceDir = 'DATA'; }
  }

  // as = 'json' | 'sqlite' → download a backup copy (only ever on request). Otherwise save to the one database file.
  // manual = the person pressed Save (so a file picker may be shown to reconnect); autosave never shows anything.
  async function saveOffline({ as, manual } = {}) {
    const m = offline.meta; if (!m) return false;
    if (offline.saving && !as) {
      if (!manual) { clearTimeout(offline.timer); offline.timer = setTimeout(() => saveOffline(), 500); return false; }
      for (let i = 0; offline.saving && i < 100; i++) await sleep(100);
      if (offline.saving) return false;
    }
    const tg = target(), rev = offline.rev || 0;
    if (!as && tg === 'browser') { data.persist(); m.fileDirty = false; m.savedAt = new Date().toISOString(); offline.setMeta(m); offlineStatus(); cloud.schedule(); return true; } // already stored in the browser
    offline.saving = true; offlineStatus();
    try {
      const blob = await DevHubDB.encode(as || m.format, data.docs, m);
      if (as) { await saveBlob(blob, m.fileName.replace(/\.[^.]+$/, '') + DevHubDB.ext(as)); return true; }
      if (tg === 'file') {
        let perm = await offline.handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = manual ? await offline.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied') : perm;
        if (perm !== 'granted') { offline.needsPermission = true; return false; }
        try { await writeToHandle(offline.handle, blob); }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          if (!manual) { offline.writeFailed = true; return false; } // autosave: pause quietly; the status line says what to do
          // Reconnect by choosing the SAME file again — it's replaced, never duplicated
          toast(`Couldn’t write to ${m.fileName}. Choose it again to reconnect.`);
          let h2 = null;
          try { h2 = await window.showSaveFilePicker({ suggestedName: m.fileName, types: PICK_TYPES(m.format), startIn: offline.handle }); } catch {}
          if (!h2) { offline.writeFailed = true; toast('Not written to the file yet — your changes are safe in this browser. ' + friendlySaveError(e)); return false; }
          await writeToHandle(h2, blob); offline.handle = h2; idb.set('offline-handle', h2); m.fileName = h2.name;
        }
        offline.needsPermission = false; offline.writeFailed = false;
      } else await writeDevice(blob, m);
      m.savedAt = new Date().toISOString();
      m.fileDirty = (offline.rev || 0) !== rev; // edited again while saving → save once more
      offline.setMeta(m);
      if (m.fileDirty) { clearTimeout(offline.timer); offline.timer = setTimeout(() => saveOffline(), 700); }
      cloud.schedule();
      return true;
    } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t save the database: ' + friendlySaveError(e)); return false; }
    finally { offline.saving = false; offlineStatus(); }
  }
  function markOfflineDirty() {
    const m = offline.meta; m.fileDirty = true; offline.rev = (offline.rev || 0) + 1; offline.setMeta(m);
    if (!offline.needsPermission && !offline.writeFailed) { clearTimeout(offline.timer); offline.timer = setTimeout(() => saveOffline(), 700); }
    offlineStatus();
  }
  function activateOffline(meta, docs, handle) {
    if (session.user) { data.wipe(session.user.id); session.clear(); }
    data.wipe('offline'); data.ns = 'offline'; data.docs = docs; data.ver = {}; data.dirty = {}; data.persist();
    offline.setMeta(meta); offline.handle = handle || null; offline.needsPermission = false; offline.writeFailed = false;
    handle ? idb.set('offline-handle', handle) : idb.del('offline-handle');
    renderNavUser(); offlineStatus();
  }
  async function closeOffline() {
    const m = offline.meta;
    if (m && target() === 'browser') { // closing removes the only copy from the browser
      if (confirm(`Closing removes “${m.name}” from this browser. Download a backup first?`)) { if (!(await saveOffline({ as: m.format }))) return false; }
      else if (!confirm('Close without a backup? The tasks will be gone from this browser.')) return false;
    } else if (m?.fileDirty) {
      if (!(await saveOffline({ manual: true })) && !confirm('The latest changes couldn’t be saved to the file. Close anyway and lose them?')) return false;
    }
    clearTimeout(offline.timer); data.wipe('offline'); data.docs = {}; offline.setMeta(null); offline.handle = null; idb.del('offline-handle'); idb.del('offline-source'); renderNavUser();
    return true;
  }
  // Where a new/migrated database goes: pick the file once on Chrome/Edge; fixed file on Android; browser elsewhere
  async function chooseTarget(meta) {
    if (!canFSA()) return null;
    const h = await window.showSaveFilePicker({ suggestedName: meta.fileName, types: PICK_TYPES(meta.format) }); // AbortError = cancelled
    meta.fileName = h.name; return h;
  }
  const savedWhereMsg = m => { const tg = target(); return tg === 'file' ? `DevHub saves into ${m.fileName} from now on` : tg === 'device' ? `saved on this device as ${whereSaved(m, tg)}` : 'saved in this browser — use Database → Download backup to keep a file'; };

  // ---------- offline database → a safe copy in an online account (you stay offline) ----------
  const cloud = {
    timer: null, busy: false, lastPush: 0,
    link() { return offline.meta && offline.meta.cloud || null; },
    save(c) { const m = offline.meta; if (!m) return; m.cloud = c; offline.setMeta(m); },
    async call(path, { method = 'GET', body, token } = {}) {
      let r; const t = token || this.link()?.token;
      try { r = await fetch(API + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
      catch { const e = new Error('Can’t reach the server — the online copy will be updated when you’re back online.'); e.offline = true; throw e; }
      let j = {}; try { j = await r.json(); } catch {}
      if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status})`); e.status = r.status; e.body = j; if (r.status === 401 && this.link()) this.save({ ...this.link(), expired: true }); throw e; }
      return j;
    },
    // update the online copy soon after changes (never more than about once a minute — the server limits saves per hour)
    schedule() { const c = this.link(); if (!c || !c.auto || c.expired) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), Math.max(15000, 60000 - (Date.now() - this.lastPush))); },
    // mode 'merge' (default): TWO-WAY. Tasks that exist only in the account are added to this database, tasks that exist only here
    // are added to the account, and a task changed in both is merged field by field. Nothing is deleted or replaced.
    // mode 'replace': the account becomes a copy of this database (only when the person chooses it).
    async push({ manual, mode = 'merge' } = {}) {
      const c = this.link(); if (!c || this.busy) return false;
      if (c.expired) { if (manual) toast('Sign in again to sync the online copy (Database page).'); return false; }
      this.busy = true;
      try {
        let adopted = false, fromOnline = 0;
        for (const name of DOCS) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const cur = await this.call('/data/' + name), local = data.docs[name];
            if (mode === 'replace') { if (local == null) break; await this.call('/data/' + name, { method: 'PUT', body: { data: local, baseVersion: cur.version || 0 } }); break; }
            const merged = local == null ? cur.data : cur.data == null ? local : mergeDoc(name, local, cur.data);
            if (merged == null) break;
            if (canon(merged) !== canon(local)) {            // the account had something this database did not: bring it in
              if (name === 'tasks') { const had = new Set((local?.tasks || []).map(t => t.id)); fromOnline += (merged.tasks || []).filter(t => !t.deleted && !had.has(t.id)).length; }
              data.docs[name] = merged; adopted = true;
            }
            if (cur.data != null && canon(merged) === canon(cur.data)) break;   // the account already has everything
            try { await this.call('/data/' + name, { method: 'PUT', body: { data: merged, baseVersion: cur.version || 0 } }); break; }
            catch (e) { if (e.status !== 409 || attempt === 2) throw e; }
          }
        }
        if (adopted) { data.persist(); markOfflineDirty(); data.changed(); }
        this.lastPush = Date.now();
        this.save({ ...this.link(), lastAt: new Date().toISOString(), error: null });
        if (manual) toast(fromOnline ? `Synced with ${c.user.username}’s account — ${fromOnline} task${fromOnline === 1 ? '' : 's'} added from online` : `Synced with ${c.user.username}’s account`);
        else if (fromOnline) toast(`${fromOnline} task${fromOnline === 1 ? '' : 's'} from your online copy added`);
        return true;
      } catch (e) {
        this.save({ ...this.link(), error: e.message });
        if (manual) toast('Online copy not synced: ' + e.message); else if (e.offline) this.schedule();
        return false;
      } finally { this.busy = false; if (document.body.dataset.route === 'account' && offline.active()) renderOfflineDb(); }
    }
  };
  // order-insensitive comparison of two documents (lists of records with ids may come back in any order)
  const canon = v => {
    if (Array.isArray(v)) { const p = v.map(canon); return '[' + (v.length && v.every(x => x && typeof x === 'object' && 'id' in x) ? p.sort() : p).join(',') + ']'; }
    if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v ?? null);
  };
  const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

  // sign in / create an account for the online copy, without leaving offline mode
  function cloudDialog(kind = 'login') {
    if (kind === 'register') loadConfig();
    let dlg = $('#cloudDlg'); if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'cloudDlg'; dlg.className = 'tk-dialog mig-dlg'; document.body.appendChild(dlg); }
    const reg = kind === 'register', m = offline.meta;
    dlg.innerHTML = `<form novalidate>
      <header class="dr-top"><h2>${reg ? 'Create an account for the online copy' : 'Sign in to keep an online copy'}</h2><button type="button" class="ghost dr-x" data-x aria-label="Close">✕</button></header>
      <p class="hint">A copy of <b>${esc(m.name)}</b> is kept in this account. You stay offline — ${esc(m.fileName)} is still the database you work in.</p>
      ${reg ? `<label for="cN">Your name</label><input id="cN" name="name" autocomplete="name">
        <label for="cU">Username</label><input id="cU" name="username" autocomplete="username" autocapitalize="off">
        <label for="cE">Email <span class="opt">(optional)</span></label><input id="cE" name="email" type="email" autocomplete="email">
        <label for="cP">Password</label><input id="cP" name="password" type="password" autocomplete="new-password" minlength="8">
        ${serverConfig.registration === 'code' ? '<label for="cC">Invite code</label><input id="cC" name="code" autocomplete="off">' : ''}`
      : `<label for="cL">Username or email</label><input id="cL" name="login" autocomplete="username" autocapitalize="off">
        <label for="cP">Password</label><input id="cP" name="password" type="password" autocomplete="current-password">`}
      <p class="form-err" role="alert" hidden></p>
      <div class="row action-bar"><button class="primary">${reg ? 'Create account' : 'Sign in'}</button>${serverConfig.registration !== 'closed' ? `<button type="button" class="ghost" data-switch>${reg ? 'I already have an account' : 'Create an account instead'}</button>` : ''}</div></form>`;
    const f = $('form', dlg), err = $('.form-err', f);
    $('[data-x]', dlg).onclick = () => dlg.close();
    const sw = $('[data-switch]', dlg); if (sw) sw.onclick = () => cloudDialog(reg ? 'login' : 'register');
    f.onsubmit = async e => {
      e.preventDefault(); err.hidden = true; fieldErrors(f);
      const btn = $('button.primary', f); btn.disabled = true;
      try {
        const body = reg ? { name: f.name.value, username: f.username.value, email: f.email.value, password: f.password.value, code: f.code?.value } : { login: f.login.value, password: f.password.value };
        const r = await cloud.call(reg ? '/auth/register' : '/auth/login', { method: 'POST', body, token: '' });
        const existing = await cloud.call('/data/tasks', { token: r.token });
        const n = (existing.data?.tasks || []).filter(t => !t.deleted).length;
        dlg.close();
        cloud.save({ token: r.token, user: r.user, auto: true, lastAt: null, sigs: {} });
        let mode = 'replace';
        if (n) mode = confirm(`${r.user.username}’s account already has ${plural(n, 'task')}.\n\nOK = add this database’s tasks to them (nothing in the account is removed)\nCancel = replace the account’s tasks with this database`) ? 'merge' : 'replace';
        if (await cloud.push({ manual: true, mode })) toast(`Online copy saved in ${r.user.username}’s account — it’s updated automatically after changes`);
        renderOfflineDb();
      } catch (x) { fieldErrors(f, x.body?.fields); err.textContent = x.message; err.hidden = false; btn.disabled = false; }
    };
    if (!dlg.open) dlg.showModal();
    setTimeout(() => $('input', f)?.focus(), 30);
  }

  // ---------- online accounts: backups you keep, and importing any task file ----------
  const bkName = () => `devhub-${slug(session.user.username)}-backup`;
  const autoBackup = {
    handle: null, timer: null, busy: false,
    key() { return 'online-backup:' + session.user.id; },
    get device() { return !!session.user && store.get('devhub:bk-device:' + session.user.id, false); },
    set device(v) { store.set('devhub:bk-device:' + session.user.id, !!v); },
    get last() { return session.user ? store.get('devhub:bk-last:' + session.user.id, null) : null; },
    on() { return !!(this.handle || (hasDeviceFs() && this.device)); },
    async load() { if (!session.user) return; this.handle = (await idb.get(this.key())) || null; },
    schedule() { if (!session.user || !this.on()) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 3000); },
    // writes the ONE backup file again (replaced in place, never a new copy)
    async run(manual) {
      if (!session.user || this.busy) return false; this.busy = true;
      try {
        const blob = await DevHubDB.encode('sqlite', data.docs, { name: `${session.user.name || session.user.username}'s tasks` });
        if (this.handle) {
          let perm = await this.handle.queryPermission({ mode: 'readwrite' });
          if (perm !== 'granted' && manual) perm = await this.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
          if (perm !== 'granted') return false;
          await writeToHandle(this.handle, blob);
        } else if (hasDeviceFs() && this.device) await writeDevice(blob, this.dev ||= { fileName: bkName() + '.sqlite' });
        else return false;
        store.set('devhub:bk-last:' + session.user.id, { at: new Date().toISOString(), where: this.handle ? this.handle.name : whereSaved(this.dev, 'device') });
        return true;
      } catch (e) { if (manual) toast('Backup not written: ' + friendlySaveError(e)); return false; }
      finally { this.busy = false; }
    }
  };
  const cleanImported = docs => { for (const t of docs.tasks.tasks) { delete t._key; delete t._base; delete t._fbase; delete t._gone; if (t.fields && !Object.keys(t.fields).length) delete t.fields; } return docs; };
  // Put imported tasks into the signed-in account. merge = keep what's there and add/update (newest edit of each task wins)
  async function importIntoAccount(incoming, mode, label) {
    const cur = data.get('tasks') || { tasks: [], projects: [], settings: { dailyGoal: 5 } };
    const inT = incoming.tasks || { tasks: [], projects: [] };
    if (mode === 'replace') {
      await saveBlob(await DevHubDB.encode('sqlite', data.docs, { name: 'before import' }), `${bkName()}-before-import-${dayKey(new Date())}.sqlite`); // safety copy first
      data.set('tasks', { ...cur, ...inT, settings: { ...(cur.settings || {}), ...(inT.settings || {}) } });
      if (Array.isArray(incoming.links) && incoming.links.length) data.set('links', incoming.links);
    } else {
      // same project name → same project
      const byName = new Map((cur.projects || []).filter(p => !p.deleted).map(p => [String(p.name).trim().toLowerCase(), p.id])), remap = new Map(), newProjects = [];
      for (const p of inT.projects || []) { const id = byName.get(String(p.name).trim().toLowerCase()); if (id && id !== p.id) remap.set(p.id, id); else newProjects.push(p); }
      const tasks = (inT.tasks || []).map(t => remap.has(t.project) ? { ...t, project: remap.get(t.project) } : t);
      data.set('tasks', { ...cur, tasks: mergeById(tasks, cur.tasks || []), projects: mergeById(newProjects, cur.projects || []) });
      if (Array.isArray(incoming.links) && incoming.links.length) data.set('links', mergeById(incoming.links, data.get('links') || []));
    }
    data.changed();
    const n = (inT.tasks || []).filter(t => !t.deleted).length;
    toast(`${mode === 'replace' ? 'Replaced your tasks with' : 'Added'} ${n} task${n === 1 ? '' : 's'} from ${label}${mode === 'replace' ? ' — your previous tasks were downloaded as a backup first' : ''}. Syncing…`);
  }
  // Import any file into the account: DevHub files directly, anything else via the contents/mapping screen
  async function importFileOnline(file) {
    file = await snapshot(file);
    let r;
    try { r = await DevHubDB.decode(file); }
    catch (e) { if (isDevHubError(e)) { await openCustomFile(file, 'tasks', { online: true }); return; } throw e; }
    const n = r.docs.tasks.tasks.filter(t => !t.deleted).length, cur = (data.get('tasks')?.tasks || []).filter(t => !t.deleted).length;
    showBackupDialog({ file, r, n, cur });
  }
  function showBackupDialog(pending) {
    if (!session.user) return;
    let dlg = $('#bkDlg'); if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'bkDlg'; dlg.className = 'tk-dialog mig-dlg'; document.body.appendChild(dlg); }
    const last = autoBackup.last, tasks = (data.get('tasks')?.tasks || []).filter(t => !t.deleted).length;
    const autoUI = canFSA() ? `<label class="check-line"><input type="checkbox" data-auto ${autoBackup.handle ? 'checked' : ''}> Keep one backup file up to date automatically${autoBackup.handle ? ` — <span class="mono">${esc(autoBackup.handle.name)}</span>` : ''}</label>`
      : hasDeviceFs() ? `<label class="check-line"><input type="checkbox" data-auto ${autoBackup.device ? 'checked' : ''}> Keep one backup file up to date automatically — <span class="mono">Documents/DevHub/${esc(bkName())}.sqlite</span></label>`
      : '<p class="hint">This browser can’t keep a file updated automatically — download a backup from time to time.</p>';
    dlg.innerHTML = pending ? `<form method="dialog">
        <header class="dr-top"><h2>Import ${esc(pending.file.name)}</h2><button class="ghost dr-x" value="cancel" aria-label="Close">✕</button></header>
        <p>DevHub database <b>“${esc(pending.r.name)}”</b> · ${plural(pending.n, 'task')} · ${plural(pending.r.docs.tasks.projects.filter(p => !p.deleted).length, 'project')} · ${plural(pending.r.docs.links.length, 'link')}</p>
        <fieldset class="fmt mig-choice">
          <label class="fmt-opt"><input type="radio" name="mode" value="merge" checked><span><b>Add to my tasks</b><small>Keeps your ${plural(pending.cur, 'task')} and adds these. A task that’s in both keeps its most recent edit.</small></span></label>
          <label class="fmt-opt"><input type="radio" name="mode" value="replace"><span><b>Replace my tasks</b><small>Your account will contain only this file’s tasks. Your current tasks are downloaded as a backup first.</small></span></label>
        </fieldset>
        <div class="row action-bar"><button class="primary" value="go">Import</button><button class="ghost" value="cancel">Cancel</button></div></form>`
      : `<form method="dialog">
        <header class="dr-top"><h2>Backup &amp; import</h2><button class="ghost dr-x" value="cancel" aria-label="Close">✕</button></header>
        <h3>Back up your tasks</h3>
        <p class="hint">Your ${plural(tasks, 'task')} are stored in your account and synced. A backup file is an extra copy you keep — open it with “Use offline” on any device, or import it here.</p>
        <div class="row"><button type="button" class="primary" data-bk="sqlite">Download backup (SQLite)</button><button type="button" data-bk="json">Download backup (JSON)</button></div>
        <div class="bk-auto">${autoUI}${last ? `<p class="hint">Last automatic backup: ${new Date(last.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · <span class="mono">${esc(last.where)}</span></p>` : ''}</div>
        <h3>Import tasks from a file</h3>
        <p class="hint">A DevHub backup, or any .db / .json / .xml task file — you’ll see what’s in it before anything changes.</p>
        <div class="row"><label class="btn">Choose file…<input type="file" data-imp hidden ${accept}></label></div>
      </form>`;
    dlg.querySelectorAll('[data-bk]').forEach(b => b.onclick = async () => { try { await saveBlob(await DevHubDB.encode(b.dataset.bk, data.docs, { name: `${session.user.name || session.user.username}'s tasks` }), `${bkName()}-${dayKey(new Date())}${DevHubDB.ext(b.dataset.bk)}`); } catch (e) { toast(e.message); } });
    const au = $('[data-auto]', dlg); if (au) au.onchange = async () => {
      if (!au.checked) { autoBackup.handle = null; idb.del(autoBackup.key()); autoBackup.device = false; toast('Automatic backup turned off'); return showBackupDialog(); }
      if (canFSA()) { try { autoBackup.handle = await window.showSaveFilePicker({ suggestedName: bkName() + '.sqlite', types: PICK_TYPES('sqlite') }); idb.set(autoBackup.key(), autoBackup.handle); } catch { au.checked = false; return; } }
      else autoBackup.device = true;
      if (await autoBackup.run(true)) toast('Backup saved — it’s updated automatically after every sync'); showBackupDialog();
    };
    const im = $('[data-imp]', dlg); if (im) im.onchange = () => { const f = im.files[0]; if (!f) return; dlg.close(); importFileOnline(f).catch(e => toast(e.message)); };
    dlg.onclose = () => { if (pending && dlg.returnValue === 'go') importIntoAccount(pending.r.docs, $('form', dlg).mode.value, pending.file.name).catch(e => toast(e.message)); };
    dlg.returnValue = ''; if (!dlg.open) dlg.showModal();
  }

  // ---------- an existing file that isn't a DevHub database: map its fields once, then migrate ----------
  const maps = { all() { return store.get('devhub:maps', {}); }, save(m) { const a = this.all(); a[m.fingerprint] = m; store.set('devhub:maps', a); } };
  let pendingCustom = null;
  async function openCustomFile(file, next, { online } = {}) {
    file = await snapshot(file);
    const info = await DevHubAdapter.inspect(file);
    if (!info.collections.length) throw new Error(`No list of records was found in ${file.name}, so it can’t be migrated as tasks.`);
    const saved = Object.values(maps.all()).find(m => info.collections.some(c => m.collection === c.id && DevHubAdapter.fingerprint(info, c.id) === m.fingerprint));
    pendingCustom = { file, info, next, online: !!online, impMode: 'merge', mapping: saved ? JSON.parse(JSON.stringify(saved)) : DevHubAdapter.guess(info), impFormat: 'sqlite', impName: file.name.replace(/\.[^.]+$/, '') };
    location.hash = 'mapfile';
  }
  // Migrate: copy the tasks into ONE new DevHub database. The original file isn't changed.
  async function migrateFile(file, mapping, format, name, next) {
    const r = await DevHubAdapter.read(file, mapping), docs = r.docs, now = new Date().toISOString();
    for (const t of docs.tasks.tasks) { delete t._key; delete t._base; delete t._fbase; delete t._gone; if (t.fields && !Object.keys(t.fields).length) delete t.fields; }
    try { docs.links = await fetch('seed/links.json').then(x => x.json()); } catch {}
    if (format === 'sqlite') await DevHubDB.loadSql();
    const meta = { id: uid(), name, format, fileName: slug(name) + DevHubDB.ext(format), createdAt: now, savedAt: null, fileDirty: true, migratedFrom: file.name };
    let handle; try { handle = await chooseTarget(meta); } catch (x) { if (x.name === 'AbortError') return false; throw x; }
    activateOffline(meta, docs, handle);
    await saveOffline({ manual: true });
    const n = docs.tasks.tasks.length, done = docs.tasks.tasks.filter(t => t.status === 'done').length;
    toast(`Migrated ${n} task${n === 1 ? '' : 's'} (${done} done) into “${name}” — ${savedWhereMsg(offline.meta)}. ${file.name} wasn’t changed.`);
    location.hash = next || 'tasks';
    return true;
  }
  const isDevHubError = e => /isn’t a DevHub database|isn’t valid JSON or SQLite/.test(e.message);

  async function openDbFile(file, handle, next) {
    let r;
    try { r = await DevHubDB.decode(file); }
    catch (e) { if (isDevHubError(e)) return openCustomFile(file, next); throw e; }
    const now = new Date().toISOString();
    activateOffline({ id: uid(), name: r.name, format: r.format, fileName: file.name, createdAt: r.createdAt || now, savedAt: now, fileDirty: false }, r.docs, handle);
    if (target() === 'device') await saveOffline(); // Android: keep it as the one file in Documents/DevHub
    const n = r.docs.tasks.tasks.filter(t => !t.deleted).length;
    toast(`Opened “${r.name}” · ${n} task${n === 1 ? '' : 's'} — ${savedWhereMsg(offline.meta)}`);
    location.hash = next || 'tasks';
  }
  async function pickDbFile(input) {
    if (canFSA()) {
      let h; try { [h] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false }); } catch (e) { if (e.name === 'AbortError') return null; throw e; }
      return { file: await h.getFile(), handle: h };
    }
    return new Promise(resolve => { input.value = ''; input.onchange = () => resolve(input.files[0] ? { file: input.files[0], handle: null } : null); input.click(); });
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-save-db]')) { e.preventDefault(); saveOffline({ manual: true }); } });

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
      const pick = side => async x => { if (x && x.size) { try { x = { ...x, blob: await snapshot(x.blob) }; } catch (e) { toast('Couldn’t read ' + x.name + ': ' + e.message); return; } } files[side] = x; info[side] = null; $(`[data-info="${side}"]`, el).textContent = ''; inspectAll(); };
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

  // ---------- text → JSON / XML mapper: read plain text, map its fields, create JSON or XML ----------
  const TM_ACCEPT = '.txt,.text,.log,.csv,.tsv,.tab,.psv,.dat,.prn,.lst,.out,text/plain,text/csv';
  const TM_SAMPLE = 'order_id|customer name|email|amount|paid|order date|tags|city\n1001|Ada Lovelace|ada@example.com|1,250.50|yes|03/02/2026|priority;b2b|London\n1002|Linus Torvalds|linus@example.com|89.99|no|15/02/2026|retail|Portland\n1003|Grace Hopper|grace@example.com|430|yes|28/02/2026|b2b;navy|Arlington\n1004|Alan Turing|alan@example.com|1,020|yes|01/03/2026||London';
  const TM_LAYOUTS = { delimited: 'Columns with a delimiter (CSV, TSV, pipe…)', kv: 'Key: value lines (one block per record)', fixed: 'Fixed-width columns', regex: 'Pattern (regular expression)', lines: 'One value per line' };
  const TM_DELIMS = { ',': 'Comma ,', '\t': 'Tab', '|': 'Pipe |', ';': 'Semicolon ;', ' ': 'Spaces', custom: 'Other…' };
  const TM_TYPES = { auto: 'Auto', text: 'Text', int: 'Whole number', num: 'Number', bool: 'True / false', date: 'Date (ISO / auto)', 'date-dmy': 'Date (DD/MM/YYYY)', 'date-mdy': 'Date (MM/DD/YYYY)', 'list;': 'List, split on ;', 'list,': 'List, split on ,', 'list|': 'List, split on |', 'list ': 'List, split on spaces', json: 'JSON value' };
  const TM_XML_AS = { el: 'Element', attr: 'Attribute', text: 'Text of parent' };
  const TM_SHAPES = { array: 'Array of records  [ {…}, {…} ]', wrap: 'Object with a list  { "records": [ … ] }', keyed: 'Object keyed by a field  { "1001": {…} }', ndjson: 'JSON Lines (one record per line)' };
  const TM_IND = { 2: '  ', 4: '    ', tab: '\t', min: '' };

  async function tmDecode(blob) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    const n = Math.min(u8.length, 4000); let z = 0; for (let i = 1; i < n; i += 2) if (u8[i] === 0) z++;
    if (n > 20 && z > n / 2 * 0.6) return new TextDecoder('utf-16le').decode(u8);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, ''); }
    catch { return new TextDecoder('windows-1252').decode(u8); }
  }
  function tmCsv(text, d) { // quote-aware split; quoted fields may contain the delimiter and line breaks
    const rows = []; let row = [], f = '', q = false, i = 0; const n = text.length, one = d.length === 1;
    while (i < n) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; } f += c; i++; continue; }
      if (c === '"' && f.trim() === '') { q = true; f = ''; i++; continue; }
      if (one ? c === d : text.startsWith(d, i)) { row.push(f); f = ''; i += d.length; continue; }
      if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
      f += c; i++;
    }
    row.push(f); rows.push(row);
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }
  const tmCount = (l, d) => { let n = 0, q = false; for (const c of l) { if (c === '"') q = !q; else if (!q && c === d) n++; } return n; };
  function tmNames(cells, n) {
    const seen = new Map();
    return Array.from({ length: n }, (_, i) => {
      let s = String(cells[i] ?? '').trim() || `column${i + 1}`; const k = s.toLowerCase();
      if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); s = `${s}_${c}`; } else seen.set(k, 1);
      return s;
    });
  }
  function tmFixedAuto(lines) {
    const L = lines.filter(l => l.trim()).slice(0, 300); if (!L.length) return [0];
    const w = Math.max(...L.map(l => l.length));
    const blank = Array.from({ length: w }, (_, i) => L.every(l => i >= l.length || l[i] === ' ' || l[i] === '\t'));
    const starts = [0]; for (let i = 1; i < w; i++) if (blank[i - 1] && !blank[i]) starts.push(i);
    return starts;
  }
  const tmPositions = s => [...new Set([0, ...String(s).split(/[\s,;]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0)])].sort((a, b) => a - b);
  const tmLooksHeader = cells => cells.length > 0 && cells.every(c => c.trim() && !/^[-+]?[\d.,\s:/$€£%-]+$/.test(c.trim())) && new Set(cells.map(c => c.trim().toLowerCase())).size === cells.length;
  const TM_KV = /^\s*([A-Za-z_][^:=\t|;,]{0,40}?)\s*([:=])(?=\s|$|[^/=])/;

  // Guess the layout of a text so the user starts from a sensible reading
  function tmDetect(text) {
    const p = { layout: 'lines', delim: ',', delimCustom: '', kvSep: ':', fixedPos: '0', regex: '', regexWhole: false, header: false, skip: 0, comment: '', trim: true };
    const all = text.split(/\r\n|\r|\n/), L = all.filter(l => l.trim()).slice(0, 80);
    if (!L.length) return p;
    const kv = L.filter(l => TM_KV.test(l));
    const hasBlank = all.slice(0, 400).some((l, i, a) => !l.trim() && i > 0 && i < a.length - 1);
    let best = null;
    for (const d of ['\t', '|', ';', ',']) {
      const counts = L.map(l => tmCount(l, d)), tally = {};
      counts.forEach(c => tally[c] = (tally[c] || 0) + 1);
      const mode = +Object.keys(tally).sort((a, b) => tally[b] - tally[a] || b - a)[0], share = tally[mode] / L.length;
      if (mode >= 1 && share >= 0.8 && (!best || share > best.share)) best = { d, share };
    }
    if (kv.length >= L.length * 0.8 && L.length >= 2 && (!best || hasBlank || best.share < 1)) {
      p.layout = 'kv'; p.kvSep = kv.filter(l => TM_KV.exec(l)[2] === '=').length > kv.length / 2 ? '=' : ':'; return p;
    }
    if (best) {
      p.layout = 'delimited'; p.delim = best.d;
      const first = tmCsv(L[0], best.d)[0] || [];
      p.header = L.length > 1 && tmLooksHeader(first); return p;
    }
    const pos = tmFixedAuto(L);
    if (L.length >= 2 && pos.length >= 2 && L.some(l => /\S {2,}\S/.test(l))) {
      p.layout = 'fixed'; p.fixedPos = pos.join(', ');
      p.header = tmLooksHeader(pos.map((s, i) => L[0].slice(s, pos[i + 1]))); return p;
    }
    if (L.length >= 2 && L.every(l => /\s/.test(l.trim()))) { p.layout = 'delimited'; p.delim = ' '; p.header = tmLooksHeader(L[0].trim().split(/\s+/)); }
    return p;
  }

  function tmTable(rows, header, T) {
    const n = Math.max(0, ...rows.map(r => r.length));
    const fields = header && rows.length ? tmNames(rows[0], n) : tmNames([], n);
    const data = header ? rows.slice(1) : rows;
    const records = data.map(r => { const o = {}; fields.forEach((k, i) => o[k] = T(r[i] ?? '')); return o; });
    const ragged = data.filter(r => r.length !== n).length;
    return { fields, records, notes: ragged ? [`${ragged.toLocaleString()} line${ragged === 1 ? ' has' : 's have'} fewer columns than the others; the missing values are left empty.`] : [] };
  }
  function tmParse(text, p) {
    let lines = text.split(/\r\n|\r|\n/);
    if (p.skip > 0) lines = lines.slice(p.skip);
    if (p.comment) lines = lines.filter(l => !l.trimStart().startsWith(p.comment));
    const T = p.trim ? s => s.trim() : s => s;
    if (p.layout === 'delimited') {
      const d = p.delim === 'custom' ? (p.delimCustom.replace(/\\t/g, '\t') || ',') : p.delim;
      const rows = d === ' ' ? lines.filter(l => l.trim()).map(l => l.trim().split(/\s+/)) : tmCsv(lines.join('\n'), d);
      return tmTable(rows, p.header, T);
    }
    if (p.layout === 'fixed') {
      const pos = tmPositions(p.fixedPos);
      return tmTable(lines.filter(l => l.trim()).map(l => pos.map((s, i) => l.slice(s, pos[i + 1]))), p.header, s => T(s).trim() === '' ? '' : T(s));
    }
    if (p.layout === 'kv') {
      const sep = p.kvSep === '\t' ? '\\t' : p.kvSep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^\\s*([^\\s${sep}][^${sep}]*?)\\s*${sep}\\s?(.*)$`);
      const records = [], order = []; let cur = null, last = null, bad = 0;
      const close = () => { if (cur) records.push(cur); cur = null; last = null; };
      for (const l of lines) {
        if (!l.trim()) { close(); continue; }
        const m = re.exec(l);
        if (m) { const k = m[1].trim(); if (cur && k in cur) close(); cur ||= {}; cur[k] = T(m[2]); last = k; if (!order.includes(k)) order.push(k); }
        else if (cur && last && /^\s/.test(l)) cur[last] += (cur[last] ? ' ' : '') + l.trim();
        else bad++;
      }
      close();
      records.forEach(r => order.forEach(k => { if (!(k in r)) r[k] = ''; }));
      return { fields: order, records: records.map(r => Object.fromEntries(order.map(k => [k, r[k]]))), notes: bad ? [`${bad.toLocaleString()} line${bad === 1 ? '' : 's'} without a “key${p.kvSep === '\t' ? ' ⇥ ' : p.kvSep + ' '}value” pair ${bad === 1 ? 'was' : 'were'} skipped.`] : [] };
    }
    if (p.layout === 'regex') {
      if (!p.regex) return { fields: [], records: [], notes: ['Enter a pattern. Name the parts you want as fields, e.g. (?<date>\\S+) (?<level>\\w+) (?<message>.*)'] };
      let re; try { re = new RegExp(p.regex, p.regexWhole ? 'gm' : ''); } catch (e) { return { fields: [], records: [], notes: [], error: 'Pattern error: ' + e.message }; }
      const rows = [], unmatched = [];
      const take = m => { if (!m) return; const g = m.groups ? Object.entries(m.groups) : m.slice(1).map((v, i) => [`group${i + 1}`, v]); rows.push(g.length ? g : [['match', m[0]]]); };
      if (p.regexWhole) { for (const m of lines.join('\n').matchAll(re)) { if (m[0] === '') break; take(m); } }
      else lines.filter(l => l.trim()).forEach(l => { const m = re.exec(l); m ? take(m) : unmatched.push(l); });
      const fields = rows.length ? rows[0].map(([k]) => k) : [];
      return { fields, records: rows.map(r => Object.fromEntries(r.map(([k, v]) => [k, T(v ?? '')]))), notes: unmatched.length ? [`${unmatched.length.toLocaleString()} line${unmatched.length === 1 ? ' doesn’t' : 's don’t'} match the pattern and ${unmatched.length === 1 ? 'was' : 'were'} skipped, e.g. “${unmatched[0].slice(0, 80)}”.`] : [] };
    }
    return { fields: ['value'], records: lines.filter(l => l.trim()).map(l => ({ value: T(l) })), notes: [] };
  }

  // Suggest a type from the values a field holds
  function tmGuessType(vals, delim) {
    const v = vals.filter(x => x !== '').slice(0, 500); if (!v.length) return 'text';
    const all = re => v.every(x => re.test(x));
    if (all(/^(true|false|yes|no|y|n)$/i) && v.some(x => !/^[01]$/.test(x))) return 'bool';
    if (all(/^[-+]?\d{1,15}$/) && !v.some(x => /^[-+]?0\d/.test(x))) return 'int';
    if (all(/^[-+]?[$€£¥₹]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/) && v.some(x => /\d/.test(x)) && !v.some(x => /^[-+]?0\d/.test(x))) return 'num';
    if (all(/^\d{4}-\d{2}-\d{2}([ T]\d{1,2}:\d{2}(:\d{2})?)?/)) return 'date';
    const dm = v.map(x => /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(x));
    if (dm.every(Boolean)) { if (dm.some(m => +m[1] > 12)) return 'date-dmy'; if (dm.some(m => +m[2] > 12)) return 'date-mdy'; }
    for (const s of [';', '|']) if (s !== delim && v.filter(x => x.includes(s)).length >= v.length / 2) return 'list' + s;
    return 'text';
  }
  const tmPad = n => String(n).padStart(2, '0');
  function tmDate(v, order) {
    const t = (h, mi, s) => h != null ? `T${tmPad(h)}:${mi}:${s || '00'}` : '';
    if (order) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v); if (!m) return null;
      let [d, mo] = order === 'dmy' ? [+m[1], +m[2]] : [+m[2], +m[1]], y = +m[3]; if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return `${y}-${tmPad(mo)}-${tmPad(d)}${t(m[4], m[5], m[6])}`;
    }
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
    if (m) return `${m[1]}-${tmPad(m[2])}-${tmPad(m[3])}${t(m[4], m[5], m[6])}`;
    const d = new Date(v); return isNaN(d) ? null : d.toISOString();
  }
  function tmConv(v, type) {
    switch (type) {
      case 'text': return { v };
      case 'auto': return /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v) ? { v: Number(v) } : v === 'true' || v === 'false' ? { v: v === 'true' } : { v };
      case 'int': { const s = v.replace(/[,\s_]/g, ''); return /^[-+]?\d+$/.test(s) && Number.isSafeInteger(+s) ? { v: +s } : { v, bad: true }; }
      case 'num': { const s = v.replace(/[,\s_]/g, '').replace(/^([-+]?)[$€£¥₹]/, '$1').replace(/%$/, ''); const n = Number(s); return s !== '' && isFinite(n) ? { v: n } : { v, bad: true }; }
      case 'bool': { const s = v.toLowerCase(); return /^(true|yes|y|1|on|t)$/.test(s) ? { v: true } : /^(false|no|n|0|off|f)$/.test(s) ? { v: false } : { v, bad: true }; }
      case 'date': case 'date-dmy': case 'date-mdy': { const d = tmDate(v, type.slice(5)); return d ? { v: d } : { v, bad: true }; }
      case 'json': try { return { v: JSON.parse(v) }; } catch { return { v, bad: true }; }
      default: if (type.startsWith('list')) { const s = type.slice(4); return { v: (s === ' ' ? v.split(/\s+/) : v.split(s)).map(x => x.trim()).filter(Boolean) }; } return { v };
    }
  }
  const tmXmlName = s => { let n = String(s).trim().replace(/[^\w.\-\u00B7\u00C0-\uFFFF]/g, '_'); if (!n) n = '_'; if (/^[^A-Za-z_\u00C0-\uFFFF]/.test(n) || /^xml/i.test(n)) n = '_' + n; return n; };
  const tmXmlEsc = (s, attr) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/"/g, attr ? '&quot;' : '"');
  const tmStyle = { asis: s => s, camel: s => { const w = words(s); return w.map((x, i) => i ? cap(x) : x).join('') || s; }, snake: s => words(s).join('_') || s, pascal: s => words(s).map(cap).join('') || s, kebab: s => words(s).join('-') || s };
  const tmSing = s => { const x = s.replace(/ies$/i, 'y').replace(/(ss|x|ch|sh)es$/i, '$1').replace(/([^s])s$/i, '$1'); return x && x !== s ? x : 'record'; };

  // One record → a JSON object and an XML node, following the mapping rows
  function tmRecord(rec, rows, o, stats) {
    const json = {}, xml = { name: o.xmlRow, attrs: [], kids: [], text: null };
    const kid = (node, name) => { let k = null; for (let i = node.kids.length - 1; i >= 0; i--) if (node.kids[i].name === name) { k = node.kids[i]; break; } if (!k) { k = { name, attrs: [], kids: [], text: null }; node.kids.push(k); } return k; };
    for (const r of rows) {
      const path = r.to.split('.').map(s => s.trim()).filter(Boolean); if (!path.length) continue;
      let raw = r.kind === 'const' ? r.value : rec[r.src] ?? '';
      if (o.trim) raw = raw.trim();
      let val;
      if (raw === '') { if (o.empty === 'omit') continue; val = o.empty === 'null' ? null : r.type.startsWith('list') ? [] : ''; }
      else { const c = tmConv(raw, r.type); if (c.bad && stats) stats.bad[r.id] = (stats.bad[r.id] || 0) + 1; val = c.v; }
      // JSON
      let j = json;
      for (const k of path.slice(0, -1)) { if (j[k] === null || typeof j[k] !== 'object' || Array.isArray(j[k])) { if (j[k] !== undefined && stats) stats.clash.add(r.to); j[k] = {}; } j = j[k]; }
      const lk = path[path.length - 1];
      if (j[lk] !== undefined && stats) stats.clash.add(r.to);
      j[lk] = val;
      // XML
      let x = xml; for (const k of path.slice(0, -1)) x = kid(x, tmXmlName(k));
      const xv = v => v === null ? null : typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
      if (r.xml === 'attr') { if (val !== null) x.attrs.push([tmXmlName(lk), Array.isArray(val) ? val.join(' ') : xv(val)]); }
      else if (r.xml === 'text') x.text = Array.isArray(val) ? val.join(' ') : xv(val);
      else if (Array.isArray(val)) val.forEach(v => x.kids.push({ name: tmXmlName(lk), attrs: [], kids: [], text: xv(v) }));
      else {
        const nm = tmXmlName(lk), ex = x.kids.find(k => k.name === nm && k.text === null && !k.filled);
        if (ex) { ex.text = xv(val); ex.filled = true; } else x.kids.push({ name: nm, attrs: [], kids: [], text: xv(val), filled: true });
      }
    }
    return { json, xml };
  }
  function tmXmlSer(node, ind, depth, out) {
    const pad = ind ? '\n' + ind.repeat(depth) : '';
    const a = node.attrs.map(([k, v]) => ` ${k}="${tmXmlEsc(v, true)}"`).join('');
    const txt = node.text === null || node.text === undefined ? '' : tmXmlEsc(node.text);
    if (!node.kids.length) { out.push(pad, txt === '' ? `<${node.name}${a}/>` : `<${node.name}${a}>${txt}</${node.name}>`); return; }
    out.push(pad, `<${node.name}${a}>`, txt);
    node.kids.forEach(k => tmXmlSer(k, ind, depth + 1, out));
    out.push(pad, `</${node.name}>`);
  }

  function textMapperTool() {
    return el => {
      const opt = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
      el.innerHTML = `<div class="tm">
        <section class="tm-step"><h3 class="mig-h"><span class="mig-n">1</span> Text <span class="hint">— upload a .txt / .log / .csv / .dat file, or paste text</span></h3>
          <div data-src></div>
          <textarea data-paste hidden spellcheck="false" autocapitalize="off" placeholder="Paste your text here"></textarea>
          <div class="row" style="margin-top:8px"><button type="button" class="ghost" data-sample>Load sample</button></div></section>
        <section class="tm-step" data-s2 hidden><h3 class="mig-h"><span class="mig-n">2</span> Read the text <span class="hint" data-det></span></h3>
          <div class="opt-grid tm-read">
            <label>Layout <select data-p="layout">${opt(TM_LAYOUTS)}</select></label>
            <label data-for="delimited">Delimiter <select data-p="delim">${opt(TM_DELIMS)}</select></label>
            <label data-for="delimited" data-custom>Other delimiter <input data-p="delimCustom" class="mono" placeholder="e.g. ~ or ::"></label>
            <label data-for="kv">Key / value separator <select data-p="kvSep"><option value=":">Colon  key: value</option><option value="=">Equals  key=value</option><option value="&#9;">Tab</option></select></label>
            <label data-for="fixed">Column start positions <span class="tm-inline"><input data-p="fixedPos" class="mono" placeholder="0, 10, 25"><button type="button" class="ghost" data-autofix>Detect</button></span></label>
            <label data-for="regex" class="tm-wide">Pattern — name each part with (?&lt;name&gt;…) <input data-p="regex" class="mono" placeholder="(?<date>\\S+) (?<level>\\w+) (?<message>.*)"></label>
            <label data-for="regex" class="check"><input type="checkbox" data-p="regexWhole"> Match across the whole text (records span lines)</label>
            <label data-for="delimited fixed" class="check"><input type="checkbox" data-p="header"> First line has the field names</label>
            <label>Skip lines at the top <input type="number" min="0" data-p="skip" value="0"></label>
            <label>Ignore lines starting with <input data-p="comment" class="mono" placeholder="e.g. # or //"></label>
            <label class="check"><input type="checkbox" data-p="trim" checked> Trim spaces around values</label>
          </div>
          <div data-parsed></div></section>
        <section class="tm-step" data-s3 hidden><h3 class="mig-h"><span class="mig-n">3</span> Map fields <span class="hint">— choose what each field becomes in JSON and XML</span></h3>
          <p class="hint tm-help">Use dots to nest: <code>customer.address.city</code> → <code>{"customer":{"address":{"city":…}}}</code> and <code>&lt;customer&gt;&lt;address&gt;&lt;city&gt;</code>. “In XML” decides whether a value is a child element, an attribute of its parent, or the parent’s own text.</p>
          <div class="table-wrap tm-map"><table><thead><tr><th title="Include">Use</th><th>Source field</th><th>Sample</th><th>→ Target name</th><th>Type</th><th>In XML</th><th><span class="sr">Order</span></th></tr></thead><tbody></tbody></table></div>
          <div class="row tm-maptools"><button type="button" class="ghost" data-addconst>+ Add fixed value</button>
            <label class="inline">Rename all <select data-style><option value="">Choose…</option><option value="camel">camelCase</option><option value="snake">snake_case</option><option value="pascal">PascalCase</option><option value="kebab">kebab-case</option><option value="asis">Same as source</option></select></label>
            <button type="button" class="ghost" data-all="1">Use all</button><button type="button" class="ghost" data-all="0">Use none</button>
            <button type="button" class="ghost" data-reset>Reset mapping</button></div></section>
        <section class="tm-step" data-s4 hidden><h3 class="mig-h"><span class="mig-n">4</span> Preview and create</h3>
          <div class="opt-grid">
            <label>JSON shape <select data-o="shape">${opt(TM_SHAPES)}</select></label>
            <label data-ofor="wrap">List key <input data-o="wrapKey" class="mono" placeholder="records"></label>
            <label data-ofor="keyed">Key field <select data-o="keyRow"></select></label>
            <label>XML root element <input data-o="xmlRoot" class="mono" placeholder="records"></label>
            <label>XML record element <input data-o="xmlRow" class="mono" placeholder="record"></label>
            <label>Group records by <select data-o="group"></select></label>
            <label>Empty values <select data-o="empty"><option value="keep">Keep as empty text</option><option value="null">Make null / empty element</option><option value="omit">Leave the field out</option></select></label>
            <label>Indent <select data-o="indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tabs</option><option value="min">Minified</option></select></label>
            <label class="check"><input type="checkbox" data-o="decl" checked> XML declaration &lt;?xml …?&gt;</label>
          </div>
          <div class="tm-warn" data-warn hidden></div>
          <p class="hint" data-pvh></p>
          <div class="grid2 tm-pv"><div><div class="tm-pvh"><b>JSON</b><button type="button" class="ghost" data-copy="json">Copy</button></div><pre class="out preview" data-pv="json"></pre></div>
            <div><div class="tm-pvh"><b>XML</b><button type="button" class="ghost" data-copy="xml">Copy</button></div><pre class="out preview" data-pv="xml"></pre></div></div>
          <div class="row action-bar"><button class="primary" data-make="json">Create JSON</button><button class="primary" data-make="xml">Create XML</button><span class="hint">Your text file isn’t changed.</span></div>
          <div data-result hidden></div></section></div>`;

      const S = { text: '', name: '', p: null, parsed: null, sig: '', rows: [], seq: 0,
        o: { shape: 'array', wrapKey: 'records', keyRow: '', xmlRoot: 'records', xmlRow: 'record', group: '', empty: 'keep', indent: '2', decl: true } };
      const paste = $('[data-paste]', el), s2 = $('[data-s2]', el), s3 = $('[data-s3]', el), s4 = $('[data-s4]', el), tbody = $('.tm-map tbody', el), resEl = $('[data-result]', el);
      const LS = 'devhub-txtmap:';
      const lsGet = k => { try { return JSON.parse(localStorage.getItem(LS + k) || 'null'); } catch { return null; } };
      const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { } };
      let tParse = 0, tPrev = 0;

      // ----- step 1: text in -----
      const src = fileSource($('[data-src]', el), { accept: TM_ACCEPT, pasteArea: paste, onFile: async x => {
        if (!x) { S.name = ''; load(paste.value, true); return; }
        paste.hidden = true;
        try { S.name = x.name; load(await tmDecode(x.blob), true); } catch (e) { toast('Couldn’t read that file: ' + e.message); }
      } });
      paste.oninput = () => { clearTimeout(tParse); tParse = setTimeout(() => { const first = t => (t.split(/\r?\n/).find(l => l.trim()) || ''); const fresh = !S.p || first(paste.value) !== first(S.text); src.clear(); S.name = ''; load(paste.value, fresh); }, 350); };
      $('[data-sample]', el).onclick = () => { src.clear(); paste.hidden = false; paste.value = TM_SAMPLE; S.name = 'orders.txt'; load(TM_SAMPLE, true); };

      function load(text, detect) {
        S.text = text || ''; resEl.hidden = true;
        const has = !!S.text.trim(); s2.hidden = s3.hidden = s4.hidden = !has;
        if (!has) return;
        if (detect || !S.p) {
          S.p = tmDetect(S.text);
          $('[data-det]', el).textContent = `— detected: ${S.p.layout === 'delimited' ? `columns separated by ${TM_DELIMS[S.p.delim].toLowerCase()}` : TM_LAYOUTS[S.p.layout].toLowerCase()}${S.p.header ? ', with a header line' : ''}. Change it below if it’s wrong.`;
          const base = (S.name || 'records').replace(/\.[^.]+$/, ''), root = tmXmlName(tmStyle.snake(base) || 'records');
          S.o.xmlRoot = root; S.o.xmlRow = tmXmlName(tmSing(root)); S.o.wrapKey = tmStyle.camel(base) || 'records';
          writeP(); writeO();
        }
        parse();
      }
      // ----- step 2: read options -----
      function writeP() {
        el.querySelectorAll('[data-p]').forEach(i => { const v = S.p[i.dataset.p]; if (i.type === 'checkbox') i.checked = !!v; else i.value = v ?? ''; });
        showP();
      }
      function showP() {
        el.querySelectorAll('[data-for]').forEach(n => n.hidden = !n.dataset.for.split(' ').includes(S.p.layout));
        $('[data-custom]', el).hidden = S.p.layout !== 'delimited' || S.p.delim !== 'custom';
      }
      el.querySelectorAll('[data-p]').forEach(i => i.addEventListener(i.tagName === 'SELECT' || i.type === 'checkbox' ? 'change' : 'input', () => {
        S.p[i.dataset.p] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Math.max(0, +i.value || 0) : i.value;
        if (i.dataset.p === 'layout' && S.p.layout === 'fixed' && tmPositions(S.p.fixedPos).length < 2) { S.p.fixedPos = tmFixedAuto(S.text.split(/\r\n|\r|\n/).slice(S.p.skip)).join(', '); writeP(); }
        $('[data-det]', el).textContent = ''; showP();
        clearTimeout(tParse); tParse = setTimeout(parse, i.tagName === 'INPUT' && i.type !== 'checkbox' ? 300 : 0);
      }));
      $('[data-autofix]', el).onclick = () => { S.p.fixedPos = tmFixedAuto(S.text.split(/\r\n|\r|\n/).slice(S.p.skip)).join(', '); writeP(); parse(); };

      function parse() {
        const out = $('[data-parsed]', el);
        let r; try { r = tmParse(S.text, S.p); } catch (e) { r = { fields: [], records: [], notes: [], error: e.message }; }
        S.parsed = r;
        const head = r.fields.slice(0, 40);
        out.innerHTML = r.error ? `<div class="out err">${esc(r.error)}</div>` : `<p class="hint"><b>${r.records.length.toLocaleString()} record${r.records.length === 1 ? '' : 's'}</b> · ${r.fields.length} field${r.fields.length === 1 ? '' : 's'}${S.name ? ` · ${esc(S.name)}` : ''}${r.records.length > 5 ? ' · first 5 shown' : ''}</p>
          ${r.notes.map(n => `<p class="hint mig-warn">${esc(n)}</p>`).join('')}
          ${head.length && r.records.length ? `<div class="table-wrap tm-parsed"><table><thead><tr>${head.map(f => `<th>${esc(f)}</th>`).join('')}</tr></thead><tbody>${r.records.slice(0, 5).map(rec => `<tr>${head.map(f => `<td>${esc(String(rec[f]).slice(0, 80))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}`;
        const ok = !r.error && r.fields.length > 0;
        s3.hidden = s4.hidden = !ok;
        if (!ok) return;
        const sig = S.p.layout + '|' + r.fields.join('\u0001');
        if (sig !== S.sig) { S.sig = sig; buildRows(); }
        else { refreshSamples(); preview(); }
      }

      // ----- step 3: mapping -----
      function defaultRows() {
        const d = S.p.layout === 'delimited' ? (S.p.delim === 'custom' ? S.p.delimCustom : S.p.delim) : '';
        return S.parsed.fields.map(f => ({ id: 'r' + (++S.seq), kind: 'field', src: f, on: true, to: tmStyle.camel(f), type: tmGuessType(S.parsed.records.slice(0, 500).map(r => r[f]), d), xml: 'el' }));
      }
      function buildRows() {
        const saved = lsGet(S.sig);
        if (saved && Array.isArray(saved.rows)) {
          S.rows = saved.rows.filter(r => r.kind === 'const' || S.parsed.fields.includes(r.src)).map(r => ({ ...r, id: 'r' + (++S.seq) }));
          S.parsed.fields.filter(f => !S.rows.some(r => r.src === f)).forEach(f => S.rows.push(...defaultRows().filter(r => r.src === f)));
          if (saved.o) { Object.assign(S.o, saved.o, { keyRow: '', group: '' }); const k = S.rows.find(r => r.src === saved.keySrc), g = S.rows.find(r => r.src === saved.groupSrc); if (k) S.o.keyRow = k.id; if (g) S.o.group = g.id; writeO(); }
          toast('Using the mapping you set for this layout last time');
        } else { S.rows = defaultRows(); S.o.keyRow = ''; S.o.group = ''; }
        renderRows();
      }
      const sampleOf = r => { if (r.kind === 'const') return ''; const v = S.parsed.records.find(x => x[r.src] !== '')?.[r.src] ?? ''; return v.length > 40 ? v.slice(0, 40) + '…' : v; };
      function renderRows() {
        tbody.innerHTML = S.rows.map((r, i) => `<tr data-id="${r.id}" class="${r.on ? '' : 'tm-off'}">
          <td><input type="checkbox" data-m="on" ${r.on ? 'checked' : ''} aria-label="Use ${esc(r.src || 'fixed value')}"></td>
          <td>${r.kind === 'const' ? `<input data-m="value" value="${esc(r.value)}" placeholder="Fixed value" aria-label="Fixed value">` : `<b>${esc(r.src)}</b>`}</td>
          <td class="hint tm-sample" data-sample>${r.kind === 'const' ? '<i>same for every record</i>' : esc(sampleOf(r))}</td>
          <td><input data-m="to" class="mono" value="${esc(r.to)}" aria-label="Target name for ${esc(r.src || 'fixed value')}"></td>
          <td><select data-m="type">${opt(TM_TYPES, r.type)}</select></td>
          <td><select data-m="xml">${opt(TM_XML_AS, r.xml)}</select></td>
          <td class="tm-ord"><button type="button" class="ghost" data-mv="-1" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="ghost" data-mv="1" ${i < S.rows.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>${r.kind === 'const' ? '<button type="button" class="ghost danger" data-del aria-label="Remove">✕</button>' : ''}</td></tr>`).join('');
        fillSelects(); preview();
      }
      function refreshSamples() { tbody.querySelectorAll('tr').forEach(tr => { const r = S.rows.find(x => x.id === tr.dataset.id); if (r && r.kind !== 'const') $('[data-sample]', tr).textContent = sampleOf(r); }); }
      tbody.addEventListener('input', e => {
        const t = e.target, tr = t.closest('tr'), r = tr && S.rows.find(x => x.id === tr.dataset.id); if (!r || !t.dataset.m) return;
        r[t.dataset.m] = t.type === 'checkbox' ? t.checked : t.value;
        if (t.dataset.m === 'on') tr.classList.toggle('tm-off', !t.checked);
        if (t.dataset.m === 'to') fillSelects();
        schedule();
      });
      tbody.addEventListener('click', e => {
        const b = e.target.closest('button'), tr = b && b.closest('tr'); if (!tr) return;
        const i = S.rows.findIndex(x => x.id === tr.dataset.id);
        if (b.dataset.mv) { const j = i + +b.dataset.mv; if (j < 0 || j >= S.rows.length) return; [S.rows[i], S.rows[j]] = [S.rows[j], S.rows[i]]; }
        else if (b.hasAttribute('data-del')) S.rows.splice(i, 1);
        else return;
        renderRows(); save();
      });
      $('[data-addconst]', el).onclick = () => { S.rows.push({ id: 'r' + (++S.seq), kind: 'const', src: '', value: '', on: true, to: 'source', type: 'text', xml: 'el' }); renderRows(); save(); const ins = tbody.querySelectorAll('[data-m="value"]'); ins[ins.length - 1]?.focus(); };
      $('[data-style]', el).onchange = e => { const f = tmStyle[e.target.value]; if (!f) return;
        S.rows.forEach(r => r.to = (r.kind === 'const' ? r.to : r.src).split('.').map(f).join('.')); e.target.value = ''; renderRows(); save(); };
      el.querySelectorAll('[data-all]').forEach(b => b.onclick = () => { S.rows.forEach(r => r.on = b.dataset.all === '1'); renderRows(); save(); });
      $('[data-reset]', el).onclick = () => { try { localStorage.removeItem(LS + S.sig); } catch { } S.rows = defaultRows(); S.o.keyRow = S.o.group = ''; renderRows(); toast('Mapping reset'); };

      // ----- step 4: output options, preview, create -----
      function fillSelects() {
        const used = S.rows.filter(r => r.on && r.to.trim()), lab = r => esc(r.to.trim() + (r.kind === 'const' ? ' (fixed)' : r.src !== r.to.trim() ? ` ← ${r.src}` : ''));
        const ks = $('[data-o="keyRow"]', el), gs = $('[data-o="group"]', el);
        ks.innerHTML = used.map(r => `<option value="${r.id}">${lab(r)}</option>`).join('');
        if (!used.some(r => r.id === S.o.keyRow)) S.o.keyRow = used[0]?.id || '';
        ks.value = S.o.keyRow;
        gs.innerHTML = `<option value="">No grouping</option>` + used.map(r => `<option value="${r.id}">${lab(r)}</option>`).join('');
        if (S.o.group && !used.some(r => r.id === S.o.group)) S.o.group = '';
        gs.value = S.o.group;
      }
      function writeO() {
        el.querySelectorAll('[data-o]').forEach(i => { if (i.type === 'checkbox') i.checked = !!S.o[i.dataset.o]; else if (i.tagName !== 'SELECT' || [...i.options].some(o => o.value === S.o[i.dataset.o])) i.value = S.o[i.dataset.o] ?? ''; });
        el.querySelectorAll('[data-ofor]').forEach(n => n.hidden = n.dataset.ofor !== S.o.shape);
      }
      el.querySelectorAll('[data-o]').forEach(i => i.addEventListener(i.tagName === 'SELECT' || i.type === 'checkbox' ? 'change' : 'input', () => {
        S.o[i.dataset.o] = i.type === 'checkbox' ? i.checked : i.value;
        el.querySelectorAll('[data-ofor]').forEach(n => n.hidden = n.dataset.ofor !== S.o.shape);
        schedule();
      }));
      function schedule() { clearTimeout(tPrev); tPrev = setTimeout(() => { preview(); save(); }, 150); }
      function save() {
        if (!S.sig) return; const k = S.rows.find(r => r.id === S.o.keyRow), g = S.rows.find(r => r.id === S.o.group);
        lsSet(S.sig, { rows: S.rows.map(({ id, ...r }) => r), o: { ...S.o, keyRow: '', group: '' }, keySrc: k?.src, groupSrc: g?.src });
      }

      // Build the JSON and/or XML text for the first `limit` records
      function build(kinds, limit, stats) {
        const o = { ...S.o, trim: S.p.trim, xmlRoot: tmXmlName(S.o.xmlRoot.trim() || 'records'), xmlRow: tmXmlName(S.o.xmlRow.trim() || 'record') };
        const rows = S.rows.filter(r => r.on && r.to.trim());
        const recs = S.parsed.records.slice(0, limit);
        const gRow = S.rows.find(r => r.id === o.group && r.on), kRow = S.rows.find(r => r.id === o.keyRow);
        const rawOf = (row, rec) => { const v = row.kind === 'const' ? row.value : rec[row.src] ?? ''; return String(v).trim() || '(empty)'; };
        const built = recs.map(rec => ({ ...tmRecord(rec, rows, o, stats), g: gRow ? rawOf(gRow, rec) : null, k: kRow ? rawOf(kRow, rec) : null }));
        const ind = TM_IND[o.indent] ?? '  ', out = {};
        const groups = () => { const m = new Map(); built.forEach(b => { if (!m.has(b.g)) m.set(b.g, []); m.get(b.g).push(b); }); return m; };
        if (kinds.includes('json')) {
          if (o.shape === 'ndjson') out.json = built.map(b => JSON.stringify(b.json)).join('\n') + (built.length ? '\n' : '');
          else {
            let doc;
            if (o.shape === 'keyed') { doc = {}; built.forEach(b => { if (b.k in doc) { if (stats) stats.dupKeys++; } else doc[b.k] = b.json; }); }
            else { const list = gRow ? Object.fromEntries([...groups()].map(([g, l]) => [g, l.map(b => b.json)])) : built.map(b => b.json); doc = o.shape === 'wrap' ? { [o.wrapKey.trim() || 'records']: list } : list; }
            out.json = JSON.stringify(doc, null, ind || undefined) + '\n';
          }
        }
        if (kinds.includes('xml')) {
          const root = { name: o.xmlRoot, attrs: [], kids: [], text: null };
          if (gRow) { const gname = tmXmlName(gRow.to.split('.').pop().trim() || 'group'); for (const [g, l] of groups()) root.kids.push({ name: gname, attrs: [['value', g]], kids: l.map(b => b.xml), text: null }); }
          else root.kids = built.map(b => b.xml);
          const body = []; tmXmlSer(root, ind, 0, body);
          out.xml = (o.decl ? '<?xml version="1.0" encoding="UTF-8"?>' : '') + body.join('').replace(/^\n/, o.decl ? '\n' : '') + '\n';
        }
        return out;
      }
      function warnings(stats, total) {
        const w = [];
        for (const [id, n] of Object.entries(stats.bad)) { const r = S.rows.find(x => x.id === id); if (r) w.push(`<b>${esc(r.to)}</b>: ${n.toLocaleString()} value${n === 1 ? '' : 's'} couldn’t be read as ${esc(TM_TYPES[r.type].toLowerCase())} and ${n === 1 ? 'was' : 'were'} kept as text.`); }
        const names = S.rows.filter(r => r.on && r.to.trim()).map(r => r.to.trim()), dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
        if (dup.length) w.push(`More than one field maps to ${dup.map(d => `<b>${esc(d)}</b>`).join(', ')} — in JSON the last one wins.`);
        stats.clash.forEach(c => { if (!dup.includes(c)) w.push(`<b>${esc(c)}</b> clashes with another nested name; one value overwrites the other.`); });
        const fixed = S.rows.filter(r => r.on && r.to.trim()).flatMap(r => r.to.split('.').map(s => s.trim()).filter(s => s && tmXmlName(s) !== s)).filter((s, i, a) => a.indexOf(s) === i);
        if (fixed.length) w.push(`Not valid XML names, adjusted in XML only: ${fixed.slice(0, 6).map(s => `<code>${esc(s)}</code> → <code>${esc(tmXmlName(s))}</code>`).join(', ')}${fixed.length > 6 ? '…' : ''}`);
        if (stats.dupKeys) w.push(`${stats.dupKeys.toLocaleString()} record${stats.dupKeys === 1 ? ' has' : 's have'} a key that’s already used, so ${stats.dupKeys === 1 ? 'it was' : 'they were'} left out of the keyed JSON. Pick a unique key field.`);
        if (!names.length) w.push('No fields are selected — tick at least one under “Use”.');
        return w;
      }
      function preview() {
        if (!S.parsed || !S.rows.length) return;
        const total = S.parsed.records.length, n = Math.min(3, total);
        const stats = { bad: {}, clash: new Set(), dupKeys: 0 }, scan = Math.min(total, 2000);
        build(['json'], scan, stats);
        const out = build(['json', 'xml'], n);
        const cut = s => s.length > 65536 ? s.slice(0, 65536) + '\n…' : s;
        $('[data-pv="json"]', el).textContent = cut(out.json); $('[data-pv="xml"]', el).textContent = cut(out.xml);
        $('[data-pvh]', el).textContent = `Preview of the first ${n} of ${total.toLocaleString()} record${total === 1 ? '' : 's'} — updates as you change the mapping.`;
        const w = warnings(stats, scan), wEl = $('[data-warn]', el);
        wEl.hidden = !w.length; wEl.innerHTML = w.map(x => `<p>${x}</p>`).join('');
        resEl.hidden = true;
      }
      el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
        if (S.parsed.records.length > 3 && S.parsed.records.length <= 20000) copy(build([b.dataset.copy], Infinity)[b.dataset.copy]);
        else if (S.parsed.records.length <= 3) copy($(`[data-pv="${b.dataset.copy}"]`, el).textContent);
        else toast('Too large to copy — use Create to download it');
      });
      el.querySelectorAll('[data-make]').forEach(b => b.onclick = () => {
        const kind = b.dataset.make;
        if (!S.rows.some(r => r.on && r.to.trim())) return toast('Tick at least one field under “Use”');
        b.disabled = true;
        setTimeout(() => {
          try {
            const t0 = performance.now(), stats = { bad: {}, clash: new Set(), dupKeys: 0 };
            const text = build([kind], Infinity, stats)[kind];
            const ext = kind === 'json' ? (S.o.shape === 'ndjson' ? 'ndjson' : 'json') : 'xml';
            const name = (S.name ? S.name.replace(/\.[^.]+$/, '') : 'data') + '.' + ext;
            const blob = new Blob([text], { type: kind === 'json' ? 'application/json' : 'application/xml' });
            const w = warnings(stats, S.parsed.records.length);
            resEl.hidden = false;
            resEl.innerHTML = `<div class="result-head"><div><b>${esc(name)}</b><div class="hint">${S.parsed.records.length.toLocaleString()} records · ${fmtBytes(blob.size)} · ${Math.round(performance.now() - t0)} ms</div></div>
              <div class="row"><button class="primary" data-dl>Download</button>${canShareFiles() ? '<button data-share>Share</button>' : ''}${blob.size < 5e6 ? '<button data-cp>Copy</button>' : ''}</div></div>
              ${w.length ? `<div class="tm-warn">${w.map(x => `<p>${x}</p>`).join('')}</div>` : ''}`;
            $('[data-dl]', resEl).onclick = () => saveBlob(blob, name).catch(e => toast(e.message));
            const sh = $('[data-share]', resEl); if (sh) sh.onclick = () => shareBlob(blob, name);
            const cp = $('[data-cp]', resEl); if (cp) cp.onclick = () => copy(text);
            saveBlob(blob, name).catch(e => toast(e.message));
            save();
          } catch (e) { resEl.hidden = false; resEl.innerHTML = `<div class="out err">${esc(e.message)}</div>`; }
          b.disabled = false;
        }, 20);
      });
    };
  }

  const FILE_TOOLS = [
    ...Object.entries(FMT).map(([k, f]) => ({ id: 'fmt-' + k, group: 'Formatters', name: `${f.name} formatter`, desc: `Pretty-print${f.minify ? ' or minify' : ''} ${f.name}${k === 'js' ? ' and TypeScript/JSX' : k === 'css' ? ', SCSS and Less' : ''}. Open a file from your device or paste text.${k === 'yaml' ? ' Comments are not kept.' : ''}`, render: formatterTool(k) })),
    { id: 'migrate', group: 'Converters', name: 'Data migrator (DB / JSON / XML)', desc: 'Move records from a .db/.sqlite, .json or .xml file into an existing .db/.sqlite, .json or .xml file — any combination. Map tables, fields and values (e.g. “Completed” → Done), preview the result, then create the updated file.', render: migratorTool() },
    { id: 'text-map', group: 'Converters', name: 'Text → JSON / XML mapper', desc: 'Upload or paste plain text (delimited columns, key: value blocks, fixed-width or log lines), map each field to a JSON key or XML element/attribute with types and nesting, preview both side by side, then create a JSON or XML file.', render: textMapperTool() },
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
  const SAP_TOOLS = [
    { id: 'sap-cva', group: 'SAP tools', name: 'SAP CVA Orchestrator', desc: 'Map SAP Code Vulnerability Analyzer findings to CVA codes (exact code, then keyword match) for up to 11 systems at once. Builds an 18-sheet CVA report per system — a remediation-category summary, findings, unique objects and object names per code, an object scorecard, object × code counts, priorities, P1/P2 backlog, RAG heatmap, unique objects — plus an executive summary and a trend-history JSON.',
      render: el => window.DHSapCva ? window.DHSapCva.render(el, { esc, toast, saveBlob }) : (el.innerHTML = '<p class="out err">The SAP CVA module did not load. Reload the page.</p>') },
    { id: 'sap-delta', group: 'SAP tools', name: 'SAP Scope Delta', desc: 'Compare two ATC / CVA result workbooks per system (A = baseline such as RISE, B = compared such as CVA). Shows the objects common to both by priority, the additional objects B adds, the additional effort as a percentage (also after a false-positive rate), and exports the full object list to Excel. Add several comparisons (A vs B, A1 vs B1 …) to see all systems side by side.',
      render: el => window.DHSapDelta ? window.DHSapDelta.render(el, { esc, toast, saveBlob }) : (el.innerHTML = '<p class="out err">The SAP Scope Delta module did not load. Reload the page.</p>') }
  ];
  const GROUPS = ['Formatters', 'Converters', 'SAP tools', 'Encode & decode', 'Text', 'Generators', 'Utilities'];
  const TOOLS = [...FILE_TOOLS, ...SAP_TOOLS, ...BASIC_TOOLS].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));

  // ---------- views ----------
  const view = () => $('#view');
  const syncLine = () => session.user || offline.meta ? `<div class="mobile-sync"><span class="ms-text">${esc($('#syncStatus')?.textContent || '')}</span>${!session.user && offline.meta ? '<button type="button" class="ghost" data-save-db hidden>Save file</button>' : ''}</div>` : '';

  const headCollapsed = () => { try { return localStorage.getItem('dh-head-collapsed') === '1'; } catch { return false; } };
  // each tool remembers whether its own header (title + description) is collapsed
  const toolCollapsed = id => { try { return (JSON.parse(localStorage.getItem('dh-tool-collapsed') || '{}'))[id] === 1; } catch { return false; } };
  const setToolCollapsed = (id, c) => { try { const m = JSON.parse(localStorage.getItem('dh-tool-collapsed') || '{}'); if (c) m[id] = 1; else delete m[id]; localStorage.setItem('dh-tool-collapsed', JSON.stringify(m)); } catch {} };
  const groupCollapsed = g => { try { return (JSON.parse(localStorage.getItem('dh-group-collapsed') || '{}'))[g] === 1; } catch { return false; } };
  const setGroupCollapsed = (g, c) => { try { const m = JSON.parse(localStorage.getItem('dh-group-collapsed') || '{}'); if (c) m[g] = 1; else delete m[g]; localStorage.setItem('dh-group-collapsed', JSON.stringify(m)); } catch {} };
  const CHEVRON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 12.5 10 7.5l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const wireCollapse = (box, btn, isCollapsed, save, labels) => { btn.onclick = () => { const c = !isCollapsed(); save(c); box.classList.toggle('collapsed', c); btn.setAttribute('aria-expanded', String(!c)); btn.title = c ? labels[1] : labels[0]; $('.sr', btn).textContent = btn.title; }; };
  function renderTools(sub) {
    const t = TOOLS.find(x => x.id === sub) || TOOLS[0];
    const grouped = GROUPS.map(g => [g, TOOLS.filter(x => x.group === g)]).filter(([, l]) => l.length);
    const hc = headCollapsed(), tc = toolCollapsed(t.id);
    view().innerHTML = `${syncLine()}<header class="page-head${hc ? ' collapsed' : ''}" id="pageHead"><div class="ph-text"><h1>Developer tools</h1><p class="lede">${TOOLS.length} tools in ${grouped.length} groups. Everything runs on your device — nothing you open or paste is uploaded.</p></div>
      <button type="button" class="ghost ph-toggle" id="phToggle" aria-expanded="${!hc}" aria-controls="pageHead" title="${hc ? 'Expand header' : 'Collapse header'}">${CHEVRON}<span class="sr">${hc ? 'Expand header' : 'Collapse header'}</span></button></header>
      <label class="picker"><span class="sr">Choose a tool</span><select id="picker">${grouped.map(([g, l]) => `<optgroup label="${esc(g)}">${l.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="tools"><nav class="tool-list" aria-label="Tools"><input id="tf" type="search" placeholder="Filter tools" aria-label="Filter tools">
      ${grouped.map(([g, l]) => { const gc = groupCollapsed(g); return `<div class="tool-group${gc ? ' collapsed' : ''}" data-g="${esc(g)}"><h3><button type="button" class="tg-toggle" aria-expanded="${!gc}" title="${gc ? 'Expand' : 'Collapse'} ${esc(g)}"><span class="tg-name">${esc(g)}</span><span class="tg-n">${l.length}</span>${CHEVRON}</button></h3>${l.map(x => `<button data-id="${x.id}" class="${x.id === t.id ? 'active' : ''}" ${x.id === t.id ? 'aria-current="page"' : ''}>${esc(x.name)}</button>`).join('')}</div>`; }).join('')}</nav>
      <section class="workspace panel"><header class="ws-top${tc ? ' collapsed' : ''}" id="wsTop"><div class="ws-head"><span class="ws-group">${esc(t.group)}</span><h2>${esc(t.name)}</h2></div>
        <button type="button" class="ghost ph-toggle ws-toggle" id="wsToggle" aria-expanded="${!tc}" aria-controls="wsDesc" title="${tc ? 'Show description' : 'Hide description'}">${CHEVRON}<span class="sr">${tc ? 'Show description' : 'Hide description'}</span></button>
        <p class="hint ws-desc" id="wsDesc">${esc(t.desc)}</p></header><div id="ws"></div></section></div>`;
    wireCollapse($('#pageHead'), $('#phToggle'), headCollapsed, c => { try { localStorage.setItem('dh-head-collapsed', c ? '1' : '0'); } catch {} }, ['Collapse header', 'Expand header']);
    wireCollapse($('#wsTop'), $('#wsToggle'), () => toolCollapsed(t.id), c => setToolCollapsed(t.id, c), ['Hide description', 'Show description']);
    view().querySelectorAll('.tool-list button[data-id]').forEach(b => b.onclick = () => location.hash = `tools/${b.dataset.id}`);
    $('#picker').onchange = e => location.hash = `tools/${e.target.value}`;
    $('#tf').oninput = e => { const q = e.target.value.toLowerCase();
      $('.tool-list').classList.toggle('filtering', !!q);   // while filtering, matches show even in collapsed groups
      view().querySelectorAll('.tool-group').forEach(g => { let any = false; g.querySelectorAll('button[data-id]').forEach(b => { const hit = (b.textContent + ' ' + g.dataset.g).toLowerCase().includes(q); b.hidden = !hit; any ||= hit; }); g.hidden = !any; }); };
    view().querySelectorAll('.tg-toggle').forEach(b => b.onclick = () => { const g = b.closest('.tool-group'), c = !g.classList.contains('collapsed'); g.classList.toggle('collapsed', c); setGroupCollapsed(g.dataset.g, c); b.setAttribute('aria-expanded', String(!c)); b.title = (c ? 'Expand ' : 'Collapse ') + g.dataset.g; });
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
  const authShell = inner => `<div class="auth"><div class="auth-card"><div class="auth-brand"><span class="brand-mark">{ }</span><span>DevHub</span></div>${offline.meta ? `<p class="form-note">Signing in closes your offline database “${esc(offline.meta.name)}” and adds its tasks to your account (nothing is deleted or replaced).${offline.meta.fileDirty ? ' It has changes that aren’t saved to the file yet — <a href="#account">save it first</a>.' : ''}</p>` : ''}${inner}</div>
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
    loadConfig();
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
        ${window.DHBio ? window.DHBio.panelHtml() : ''}
        <section class="panel"><h2>Sync and data</h2>
          <p class="hint" id="acctSync">${data.hasUnsynced() ? 'Some changes are waiting to sync.' : 'Everything is synced.'}</p>
          <div class="row"><button id="syncNow">Sync now</button><button id="bkOpen" class="primary">Backup &amp; import…</button><button id="ex">Export JSON</button><button id="exq">Export SQLite</button></div>
          <p class="hint" style="margin-top:10px">Backups are offline databases too — open one with “Use offline” on any device. Import accepts DevHub backups and any .db / .json / .xml task file.</p></section>
        <section class="panel"><h2>Sessions</h2>
          <div class="row"><button id="so">Sign out</button><button id="soa">Sign out on all devices</button></div>
          <h2 style="margin-top:22px">Delete account</h2><p class="hint">Permanently deletes your account and all your tasks and links.</p>
          <button class="danger" id="del">Delete account…</button></section>
      </div>`;
    if (window.DHBio) window.DHBio.wirePanel();
    const pf = $('#pf');
    pf.onsubmit = async e => { e.preventDefault(); fieldErrors(pf);
      try { const r = await api('/auth/profile', { method: 'POST', body: { name: pf.name.value, email: pf.email.value } }); session.setUser(r.user); renderNavUser(); toast('Profile saved'); }
      catch (x) { fieldErrors(pf, x.body?.fields); toast(x.message); } };
    const pwf = $('#pwf');
    pwf.onsubmit = async e => { e.preventDefault(); fieldErrors(pwf);
      if (pwf.next.value.length < 8) return fieldErrors(pwf, { next: 'Use at least 8 characters.' });
      try { const r = await api('/auth/password', { method: 'POST', body: { current: pwf.current.value, next: pwf.next.value } }); session.save(r.token, r.user, !!localStorage.getItem('devhub:token')); if (window.DHBio) await window.DHBio.refresh(r.token, r.user); pwf.reset(); toast('Password changed'); }
      catch (x) { fieldErrors(pwf, x.body?.fields); if (!x.body?.fields) toast(x.message); } };
    $('#syncNow').onclick = async () => { await pull(); await push(); $('#acctSync').textContent = data.hasUnsynced() ? 'Some changes are waiting to sync.' : 'Everything is synced.'; };
    const dbMeta = { name: `${u.name || u.username}'s tasks` };
    $('#ex').onclick = async () => saveBlob(await DevHubDB.encode('json', data.docs, dbMeta), `devhub-${u.username}-${dayKey(new Date())}.json`);
    $('#exq').onclick = async () => { try { saveBlob(await DevHubDB.encode('sqlite', data.docs, dbMeta), `devhub-${u.username}-${dayKey(new Date())}.sqlite`); } catch (x) { toast(x.message); } };
    $('#bkOpen').onclick = () => showBackupDialog();
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
          <p>No account. Your tasks live in one database on this device. Open a DevHub database, or an existing .db / .json / .xml task file to migrate it once.</p>
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
        <p class="hint">${canFSA() ? 'Next you’ll choose where to save the file. After that, every change is saved into that same file automatically.' : hasDeviceFs() ? 'It’s saved on this device in Documents/DevHub, and every change updates that same file automatically.' : 'It’s saved inside this browser automatically (this browser can’t write into a file on your device). Use Database → Download backup whenever you want a file.'}</p>
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
          await saveOffline({ manual: true });
          toast(`Created “${name}” — ${savedWhereMsg(offline.meta)}`); location.hash = next;
        } catch (x) { ferr.textContent = x.message; ferr.hidden = false; btn.disabled = false; btn.textContent = 'Create database'; }
      };
    };
  }

  // ---------- offline database page ----------
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function renderOfflineDb() {
    const m = offline.meta, t = data.get('tasks') || {}, tasks = (t.tasks || []).filter(x => !x.deleted), links = (data.get('links') || []).filter(x => !x.deleted);
    const tg = target();
    const saving = tg === 'file' ? `Automatic — every change is saved into <b class="mono">${esc(m.fileName)}</b> (the same file, never a copy)`
      : tg === 'device' ? `Automatic — every change is saved into <b class="mono">${esc(whereSaved(m, tg))}</b> on this device (the same file, never a copy)`
      : 'Automatic — saved inside this browser. This browser can’t write into a file on your device, so use <b>Download backup</b> when you want a file.';
    view().innerHTML = `${syncLine()}<h1>Offline database</h1><p class="lede">One database, saved automatically. No account needed.</p>
      <div class="acct-grid">
        <section class="panel"><h2>${esc(m.name)}</h2>
          <dl class="kv2"><dt>Format</dt><dd>${m.format === 'sqlite' ? 'SQLite' : 'JSON'}</dd>
            <dt>Saving</dt><dd>${saving}</dd>${m.migratedFrom ? `<dt>Migrated from</dt><dd class="mono">${esc(m.migratedFrom)} <span class="hint">(not changed)</span></dd>` : ''}
            <dt>Last saved</dt><dd>${m.savedAt ? new Date(m.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</dd>
            <dt>Contents</dt><dd>${plural(tasks.length, 'task')} · ${plural((t.projects || []).filter(p => !p.deleted).length, 'project')} · ${plural(links.length, 'link')}</dd></dl>
          <div class="row" style="margin-top:14px">${tg !== 'browser' ? '<button class="primary" id="dbSave">Save now</button>' : ''}${tg === 'browser' && canFSA() ? '<button class="primary" id="dbReconnect" title="Choose a file on this computer; every change is then saved into it">Save into a file on this computer…</button>' : ''}</div>
        </section>
        <section class="panel cloud-panel"><h2>Online copy <span class="hint">for safe keeping</span></h2>
          ${(() => { const c = m.cloud; if (!c) return `<p class="hint">Keep a copy of this database in a DevHub account, so it’s safe even if this device or file is lost — and you can reach it from any device by signing in. You stay offline: this database is still the one you work in.</p>
            <div class="row"><button class="primary" id="clIn">Sign in…</button>${serverConfig.registration !== 'closed' ? '<button id="clReg">Create account…</button>' : ''}</div>`;
            return `<dl class="kv2"><dt>Account</dt><dd><b>${esc(c.user.name || c.user.username)}</b> <span class="hint">@${esc(c.user.username)}</span></dd>
              <dt>Last synced</dt><dd>${c.lastAt ? new Date(c.lastAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet'}${c.error ? ` <span class="mig-bad">· ${esc(c.error)}</span>` : ''}</dd></dl>
              ${c.expired ? '<p class="form-err">The sign-in for the online copy has ended. Sign in again to keep it updated.</p><div class="row"><button class="primary" id="clIn">Sign in again…</button><button class="ghost" id="clOff">Stop online copy</button></div>'
              : `<label class="check-line"><input type="checkbox" id="clAuto" ${c.auto ? 'checked' : ''}> Keep this database and the online copy in sync automatically</label>
              <div class="row" style="margin-top:10px"><button class="primary" id="clNow">Sync now</button><button class="ghost" id="clOff">Stop online copy</button></div>
              <p class="hint" style="margin-top:8px">The database and the online copy are merged both ways: tasks added online appear here, tasks added here appear online, and nothing is replaced or lost. To work online instead, use “Close and sign in” below.</p>`}`; })()}
        </section>
        <section class="panel"><h2>Download backup</h2><p class="hint">A one-off copy, only when you ask for it. Both formats hold the same data${tg === 'browser' ? ' — keep one somewhere safe, because clearing this browser’s data removes the database' : ''}.</p>
          <div class="row"><button id="dlSqlite">Backup as SQLite</button><button id="dlJson">Backup as JSON</button></div>
          <p class="hint" style="margin-top:12px">For a copy that’s kept up to date without files, use <b>Online copy</b>.</p></section>
        <section class="panel"><h2>Switch database</h2>
          <p class="hint">Open a DevHub database, or an existing .db / .json / .xml task file to migrate it.</p>
          <div class="row"><button id="dbOpen">Open another file</button><button id="dbNew">Create new database</button></div><input type="file" id="dbFile" hidden ${accept}>
          <h2 style="margin-top:22px">Use online instead</h2><p class="hint">Close this database and sign in to sync across devices.</p>
          <button id="dbOnline">Close and sign in</button></section>
      </div>`;
    offlineStatus();
    const sv = $('#dbSave'); if (sv) sv.onclick = () => saveOffline({ manual: true }).then(ok => { if (ok) { toast('Saved to ' + whereSaved(offline.meta)); renderOfflineDb(); } });
    const rc = $('#dbReconnect'); if (rc) rc.onclick = async () => {
      let h; try { h = await window.showSaveFilePicker({ suggestedName: m.fileName, types: PICK_TYPES(m.format) }); } catch (e) { if (e.name !== 'AbortError') toast(e.message); return; }
      offline.handle = h; idb.set('offline-handle', h); m.fileName = h.name; offline.setMeta(m); offline.writeFailed = false;
      if (await saveOffline({ manual: true })) { toast('Every change now saves into ' + h.name); renderOfflineDb(); }
    };
    $('#dlJson').onclick = () => saveOffline({ as: 'json' });
    $('#dlSqlite').onclick = () => saveOffline({ as: 'sqlite' });
    const ci = $('#clIn'); if (ci) ci.onclick = () => cloudDialog('login');
    const cr = $('#clReg'); if (cr) cr.onclick = () => cloudDialog('register');
    const cn = $('#clNow'); if (cn) cn.onclick = async () => { cn.disabled = true; await cloud.push({ manual: true }); };
    const ca = $('#clAuto'); if (ca) ca.onchange = () => { cloud.save({ ...cloud.link(), auto: ca.checked }); if (ca.checked) cloud.schedule(); toast(ca.checked ? 'The online copy updates automatically' : 'Automatic sync off — use Sync now'); };
    const co = $('#clOff'); if (co) co.onclick = () => { if (!confirm('Stop keeping an online copy? The copy already in the account stays there.')) return; cloud.save(null); toast('Online copy stopped — the account still has the last copy'); renderOfflineDb(); };
    $('#dbOpen').onclick = async () => {
      let r; try { r = await pickDbFile($('#dbFile')); } catch (e) { return toast(e.message); }
      if (!r) return;
      try { r.file = await snapshot(r.file); await DevHubDB.decode(r.file); } catch (e) { if (!isDevHubError(e)) return toast(e.message); }
      if (await closeOffline()) openDbFile(r.file, r.handle, 'tasks').catch(e => toast(e.message));
    };
    $('#dbNew').onclick = async () => { if (await closeOffline()) { location.hash = 'start?next=tasks'; setTimeout(() => $('#stNew')?.click(), 50); } };
    $('#dbOnline').onclick = async () => { if (await closeOffline()) location.hash = 'login?next=tasks'; };
  }

  // ---------- migrate an existing file: map fields and values once ----------
  function renderMapFile() {
    const P = pendingCustom;
    if (!P || (P.online && !session.user)) { location.replace(session.user || offline.meta ? '#tasks' : '#start?next=tasks'); return; }
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
      const shown = info.collections.find(x => x.id === P.view) || c;
      const kindName = { sqlite: 'SQLite database', json: 'JSON file', xml: 'XML file' }[info.kind];
      const where = canFSA() ? 'You’ll choose where to save it, and DevHub saves into that same file from then on.' : hasDeviceFs() ? 'It’s saved on this device in Documents/DevHub and updated in place from then on.' : 'It’s saved in this browser from then on (this browser can’t write into a file on your device) — use Download backup for a file.';
      const roleSummary = A.ROLES.filter(([k]) => m.roles[k]).map(([k, l]) => `${esc(l)} ← <span class="mono">${esc(m.roles[k])}</span>`).join(' · ');
      view().innerHTML = `<h1>${esc(P.file.name)}</h1>
        <p class="lede">${kindName} · ${plural(info.collections.length, info.kind === 'sqlite' ? 'table' : 'list')} · ${fmtBytes(P.file.size)}. ${P.online ? 'Look at what’s inside, then import its tasks into your account.' : 'Look at what’s inside, then migrate it into a new DevHub database — the file you’ll work with from now on.'} ${esc(P.file.name)} itself isn’t changed.</p>
        <section class="panel mf-view">
          <h2><span class="mig-n">1</span> What’s in the file</h2>
          <div class="seg mf-tabs" role="tablist">${info.collections.map(x => `<button type="button" role="tab" aria-selected="${x.id === shown.id}" data-show="${esc(x.id)}">${esc(x.label)} <span class="hint">${x.count.toLocaleString()}</span></button>`).join('')}</div>
          ${shown.columns.length ? `<p class="hint">${shown.count > shown.rows.length ? `First ${shown.rows.length} of ${shown.count.toLocaleString()} rows` : plural(shown.count, 'row')} · ${plural(shown.columns.length, 'column')}</p>
          <div class="table-wrap mf-grid"><table><thead><tr>${shown.columns.map(x => `<th>${esc(x.name)}${x.pk ? ' 🔑' : ''}</th>`).join('')}</tr></thead><tbody>${shown.rows.map(r => `<tr>${r.map(v => `<td title="${esc(v.length > 60 ? v : '')}">${esc(v.length > 60 ? v.slice(0, 60) + '…' : v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${shown.columns.length}" class="hint">No rows</td></tr>`}</tbody></table></div>` : '<p class="hint">This is empty.</p>'}
        </section>
        <section class="panel mf">
          <h2><span class="mig-n">2</span> ${P.online ? 'Import into your account' : 'Migrate to a new DevHub database'}</h2>
          <div class="opt-grid mf-top">
            <label>Tasks are in<select id="mfCol">${info.collections.map(x => opt(x.id, `${x.label} (${x.count} records)`, x.id === m.collection)).join('')}</select></label>
            ${P.online ? '' : `<label>New database name<input id="mfName" value="${esc(P.impName)}" maxlength="60"></label>`}
          </div>
          ${P.online ? `<fieldset class="fmt mf-fmt"><legend>How</legend>
            <label class="fmt-opt"><input type="radio" name="mfImp" value="merge" ${P.impMode === 'merge' ? 'checked' : ''}><span><b>Add to my tasks</b><small>Keeps your current tasks and adds these. Importing the same file again updates them instead of duplicating.</small></span></label>
            <label class="fmt-opt"><input type="radio" name="mfImp" value="replace" ${P.impMode === 'replace' ? 'checked' : ''}><span><b>Replace my tasks</b><small>Your account will contain only these tasks. Your current tasks are downloaded as a backup first.</small></span></label>
          </fieldset>` : ''}
          <fieldset class="fmt mf-fmt" ${P.online ? 'hidden' : ''}><legend>Save as</legend>
            <label class="fmt-opt"><input type="radio" name="mfFmt" value="sqlite" ${P.impFormat === 'sqlite' ? 'checked' : ''}><span><b>SQLite database</b><small>A real database file. Open it with DB Browser for SQLite, sqlite3 or DBeaver too.</small></span></label>
            <label class="fmt-opt"><input type="radio" name="mfFmt" value="json" ${P.impFormat === 'json' ? 'checked' : ''}><span><b>JSON</b><small>Readable text — easy to look inside or keep in Git.</small></span></label>
          </fieldset>
          ${P.online ? '' : `<p class="hint">${where}</p>`}
          <details class="mf-map" ${P.mapOpen ? 'open' : ''}><summary>How the fields map <span class="hint">— worked out automatically; open to check or change</span></summary>
          <p class="hint mf-sum">${roleSummary || 'No fields matched yet — choose at least the title.'}${m.roles.status && vals(m.roles.status) ? ` · status: ${vals(m.roles.status).map(x => `${esc(x.s || '(empty)')} → ${esc(A.STATUS_LABEL[m.statusMap[x.s]] || 'To do')}`).join(', ')}` : ''}</p>
          <div class="opt-grid mf-top"><label>Unique id<select id="mfKey">${opt('', info.kind === 'sqlite' ? '— row id —' : '— row position —', !m.key)}${c.columns.map(x => opt(x.name, x.name, x.name === m.key)).join('')}</select></label></div>
          <div class="table-wrap"><table class="mf-roles"><thead><tr><th>DevHub</th><th>Your field</th><th>Example</th></tr></thead><tbody>
            ${A.ROLES.map(([k, l]) => { const ex = (c.columns.find(x => x.name === m.roles[k]) || {}).sample || []; return `<tr><td><b>${esc(l)}</b>${k === 'title' ? ' <span class="hint">required</span>' : ''}</td><td><select data-role="${k}">${colOpts(m.roles[k])}</select></td><td class="hint">${esc(ex.slice(0, 2).join(' · ').slice(0, 80))}</td></tr>`; }).join('')}
          </tbody></table></div>
          ${m.roles.status ? `<h3>Status values</h3>${valueTable('status', m.statusMap, [['todo', A.STATUS_LABEL.todo], ['doing', A.STATUS_LABEL.doing], ['done', A.STATUS_LABEL.done]])}` : ''}
          ${m.roles.priority ? `<h3>Priority values</h3>${valueTable('priority', m.prioMap, [[1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low']])}` : ''}
          <p class="hint">${extra.length ? `Other fields (<span class="mono">${esc(extra.join(', '))}</span>) are kept, and editable in each task’s details.` : 'Every field is mapped.'}</p>
          </details>
          <p class="form-err" id="mfErr" role="alert" hidden></p>
          <div class="row action-bar"><button class="primary" id="mfGo">${P.online ? `Import ${c.count} task${c.count === 1 ? '' : 's'}` : `Migrate ${c.count} task${c.count === 1 ? '' : 's'} and save`}</button><button type="button" class="ghost" id="mfCancel">Cancel</button></div>
        </section>`;
      view().querySelectorAll('[data-show]').forEach(bt => bt.onclick = () => { P.view = bt.dataset.show; draw(); });
      view().querySelectorAll('[name="mfFmt"]').forEach(r => r.onchange = () => { P.impFormat = r.value; });
      view().querySelectorAll('[name="mfImp"]').forEach(r => r.onchange = () => { P.impMode = r.value; });
      const det = $('.mf-map'); det.ontoggle = () => { P.mapOpen = det.open; };
      const nm = $('#mfName'); if (nm) nm.oninput = () => { P.impName = nm.value; };
      $('#mfCol').onchange = e => { m = P.mapping = A.guess(info, e.target.value); P.view = e.target.value; draw(); };
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
      $('#mfCancel').onclick = () => { const on = P.online; pendingCustom = null; location.hash = on ? 'tasks' : offline.meta ? 'account' : 'start?next=tasks'; };
      $('#mfGo').onclick = async () => {
        const err = $('#mfErr'); err.hidden = true;
        if (!m.roles.title) { P.mapOpen = true; draw(); const e2 = $('#mfErr'); e2.textContent = 'Choose which field holds the task title (under “How the fields map”).'; e2.hidden = false; return; }
        const label = b0 => b0.textContent = `Migrate ${col().count} tasks and save`;
        if (P.online) {
          const b = $('#mfGo'); b.disabled = true; b.textContent = 'Importing…';
          try { m.formats ||= {}; A.finish(info, m); maps.save(m);
            const r = await DevHubAdapter.read(P.file, m); await importIntoAccount(cleanImported(r.docs), P.impMode, P.file.name);
            pendingCustom = null; location.hash = 'tasks'; }
          catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; b.textContent = 'Try again'; }
          return;
        }
        if (!P.impName.trim()) { err.textContent = 'Give the new DevHub database a name.'; err.hidden = false; return; }
        const b = $('#mfGo'); b.disabled = true; b.textContent = 'Migrating…';
        try {
          m.formats ||= {}; A.finish(info, m); maps.save(m);
          if (offline.meta && !(await closeOffline())) { b.disabled = false; label(b); return; }
          if (!(await migrateFile(P.file, m, P.impFormat, P.impName.trim(), P.next))) { b.disabled = false; label(b); return; }
          pendingCustom = null;
        } catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; b.textContent = 'Try again'; }
      };
    }
    draw();
  }

  // ---------- router ----------
  const routes = { tools: sub => renderTools(sub), links: renderLinks, account: () => offline.active() ? renderOfflineDb() : renderAccount(), login: renderLogin, register: renderRegister, start: renderStart, mapfile: renderMapFile };
  const PRIVATE = new Set(['tasks', 'links', 'account']);
  function render() {
    if (window.DHBio && window.DHBio.locked()) return;   // nothing is shown until the fingerprint is accepted
    let [route, sub] = (location.hash.slice(1).split('?')[0] || 'tools').split('/');
    if (route === 'today' || route === 'settings') route = route === 'today' ? 'tasks' : 'account';
    if (PRIVATE.has(route) && !session.user && !offline.meta) { location.replace('#start?next=' + route); return; }
    document.querySelectorAll('.nav a[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === route || (route === 'start' && a.dataset.route === 'account')));
    document.body.dataset.route = route;
    (routes[route] || routes.tools)(sub);
    if (PRIVATE.has(route) && session.user && session.token && Date.now() - lastWake > 60000) wakeAndSync();   // opening Tasks / Tool stores / Account wakes the server
    if (offline.active()) offlineStatus();
  }
  window.addEventListener('hashchange', () => { render(); view().focus({ preventScroll: true }); window.scrollTo(0, 0); });
  window.addEventListener('online', () => { if (session.user && session.token) wakeAndSync(); else if (offline.active()) cloud.schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') return; if (session.user && session.token && !pushing) wakeAndSync(); else if (offline.active()) cloud.schedule(); });
  setInterval(() => { if (!document.hidden && offline.active()) cloud.schedule(); }, 300000);
  data.listeners.add(() => { const r = document.body.dataset.route; if ((r === 'tasks' || r === 'links') && !document.querySelector('dialog[open]')) render(); });

  // Shared with tasks.js
  // What the task tracker needs to adapt to your own file (null for DevHub databases and online accounts)
  const custom = () => null; // (the tracker always uses DevHub's own format now; migrated extra fields still show per task)
  window.DH = { $, esc, toast, uid, dayKey, addDays, store, data, session, api, routes, render, copy, saveBlob, view, syncLine, custom, backup: () => showBackupDialog(), unlock: unlockApp, relock: relockApp, renderNavUser };

  window.addEventListener('DOMContentLoaded', () => {
    const bioLocked = !!(window.DHBio && window.DHBio.locked());   // fingerprint unlock is on and nobody has unlocked yet
    if (bioLocked) { /* stay quiet: no data, no network until the fingerprint is accepted */ }
    else if (session.user && session.token) { data.ns = session.user.id; data.load(); autoBackup.load(); }
    else {
      session.clear();
      if (offline.meta) {
        data.ns = 'offline'; data.load();
        setTimeout(() => { const c = cloud.link(); if (c && c.auto && !c.expired) cloud.push(); }, 2500);   // bring in anything added online since last time
        if (offline.meta.adapter) { const m = offline.meta; delete m.adapter; m.migratedFrom = m.fileName; m.format = 'sqlite'; m.fileName = slug(m.name) + '.sqlite'; m.fileDirty = true; offline.setMeta(m); idb.del('offline-handle'); idb.del('offline-source'); }
        idb.get('offline-handle').then(async h => { // reconnect to the file picked earlier (Chrome/Edge desktop)
          if (!h || !offline.meta) { if (offline.meta?.fileDirty && target() !== 'file') saveOffline(); return; }
          offline.handle = h;
          try { if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && offline.meta.fileDirty) offline.needsPermission = true; } catch {}
          offlineStatus();
        });
      }
    }
    renderNavUser();
    if (bioLocked) window.DHBio.lock();
    else { render(); if (session.user && session.token) wakeAndSync(); }
    if ('serviceWorker' in navigator && !isNative()) {
      const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
      // A new version was deployed: its service worker takes over, then reload once so every file is the new one
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      }).catch(console.error);
    }
  });
})();
