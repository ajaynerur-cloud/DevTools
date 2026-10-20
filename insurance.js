/* Toolbox+ Insurance — keep your insurance policies, their documents and renewal reminders.
 *
 *  - Works fully OFFLINE and needs no account: policies and attachments are stored on this device only (IndexedDB),
 *    are never sent to the Toolbox+ server (Render) and are not part of account sync. Use Export / Import to move them.
 *  - Reminders: every day from N days (default 30) before the next renewal date until the policy is marked renewed,
 *    with per-policy repetition (every day / every week / chosen days; once, twice, every 4 h or every hour a day; daily when
 *    overdue) and Snooze (15 min, 1 h, tomorrow… from the notification itself or the policy card).
 *      Android app : scheduled with the OS alarm manager (exact, allowed while idle), so they arrive with the app closed,
 *                    after a reboot too; the next 31 days are scheduled every time the app opens.
 *      Browser     : shown while Toolbox+ is open in a tab or installed as an app (browsers can't wake a closed page);
 *                    "Add to calendar" puts a daily reminder series into Outlook / Google Calendar for desktops.
 */
(() => {
  'use strict';
  const DH = window.DH; if (!DH) return;
  const { $, esc, toast, uid, view, routes, saveBlob } = DH;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const daysBetween = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
  const fmtDay = s => { const d = parseDay(s); return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  // reminder window: N days before the next date, or from a chosen date (startMode 'date' + remindFrom)
  const beforeOf = p => { if (p.startMode === 'date' && p.remindFrom && p.nextDate) { const a = parseDay(p.remindFrom), b = parseDay(p.nextDate); if (a && b) return Math.max(0, daysBetween(a, b)); } const n = parseInt(p.daysBefore, 10); return n >= 0 ? n : 30; };
  const TYPES = ['Health', 'Life', 'Car', 'Two-wheeler', 'Home', 'Travel', 'Term', 'Other'];

  /* ---------------- storage: IndexedDB on this device ---------------- */
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const q = indexedDB.open('devhub-insurance', 1);
        q.onupgradeneeded = () => { const db = q.result; if (!db.objectStoreNames.contains('policies')) db.createObjectStore('policies', { keyPath: 'id' }); if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }); };
        q.onsuccess = () => { this.db = q.result; res(this.db); }; q.onerror = () => rej(q.error);
      });
    },
    async run(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => { const tx = db.transaction(store, mode); const r = fn(tx.objectStore(store)); tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Storage is full or blocked')); });
    },
    all(store) { return this.run(store, 'readonly', s => s.getAll()); },
    get(store, id) { return this.run(store, 'readonly', s => s.get(id)); },
    put(store, v) { return this.run(store, 'readwrite', s => s.put(v)); },
    del(store, id) { return this.run(store, 'readwrite', s => s.delete(id)); }
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});   // ask the browser not to evict it

  const SKEY = 'devhub:insurance';
  const settings = () => { try { return { on: true, time: '09:00', ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { on: true, time: '09:00' }; } };
  const setSettings = p => { try { localStorage.setItem(SKEY, JSON.stringify({ ...settings(), ...p })); } catch {} resync(); };
  let cache = null;   // policies in memory
  async function policies() { if (!cache) { try { cache = await idb.all('policies'); } catch { cache = []; } } return cache.filter(p => !p.deleted); }
  async function savePolicy(p) { p.updatedAt = new Date().toISOString(); await idb.put('policies', p); cache = null; resync(); }
  const resync = () => { if (window.DHNotify) window.DHNotify.sync(); };

  /* ---------------- reminders ---------------- */
  // days left until the next date (negative = overdue) and whether today is inside the reminder window
  function state(p, on = new Date()) {
    const due = parseDay(p.nextDate); if (!due) return { kind: 'none', left: null };
    const left = daysBetween(on, due), before = beforeOf(p);
    return { left, kind: left < 0 ? 'overdue' : left === 0 ? 'today' : left <= before ? 'soon' : 'later' };
  }
  const leftText = left => left < 0 ? `overdue by ${-left} day${left === -1 ? '' : 's'}` : left === 0 ? 'due today' : `due in ${left} day${left === 1 ? '' : 's'}`;
  // ---- repetition rules (per policy) ----
  //   days    : 'daily' (every day of the window) | 'weekly' (every 7 days counting back from the next date) | 'custom' (only on the listed days before)
  //   perDay  : 'once' | 'twice' (at the time and 9 h later) | '4h' (every 4 hours until 22:00) | '1h' (every hour until 22:00)
  //   overdue : keep reminding every day after the next date until it's marked renewed (up to 60 days)
  //   snoozeUntil : no reminders before this moment, then one reminder at it
  const DAY_RULES = { daily: 'Every day', weekly: 'Every week', custom: 'Only on chosen days' };
  const PER_DAY = { once: 'once a day', twice: 'twice a day', '4h': 'every 4 hours', '1h': 'every hour' };
  const SNOOZES = { snooze15: ['15 minutes', 15 * 6e4], snooze60: ['1 hour', 36e5], snooze180: ['3 hours', 3 * 36e5], tomorrow: ['Tomorrow', 'tomorrow'], days3: ['3 days', 3 * 864e5], week: ['1 week', 7 * 864e5] };
  const timeOf = p => (p.time || settings().time || '09:00');
  const customDays = p => String(p.customDays || '30,15,7,3,1,0').split(/[^\d]+/).filter(Boolean).map(Number);
  function slotsFor(p) {
    const [h, m] = timeOf(p).split(':').map(Number), base = (h || 0) * 60 + (m || 0), out = [base], end = 22 * 60;
    const step = { twice: 9 * 60, '4h': 240, '1h': 60 }[p.perDay];
    if (step) for (let t = base + step; t <= Math.max(end, base) && t < 24 * 60; t += step) { out.push(t); if (p.perDay === 'twice') break; }
    return out;
  }
  function dayWanted(p, left) {
    if (left > beforeOf(p)) return false;
    if (left < 0) return p.overdue !== false && left >= -60;
    if (p.days === 'weekly') return left % 7 === 0;
    if (p.days === 'custom') return customDays(p).includes(left);
    return true;
  }
  const ruleText = p => p.remind === false ? 'Off' : `${p.days === 'custom' ? 'On ' + customDays(p).join(', ') + ' days before' : (DAY_RULES[p.days] || DAY_RULES.daily) + (p.startMode === 'date' && p.remindFrom ? ' from ' + fmtDay(p.remindFrom) : ' from ' + beforeOf(p) + ' days before')}, ${!p.perDay || p.perDay === 'once' ? 'once a day at ' + timeOf(p) : PER_DAY[p.perDay] + ' from ' + timeOf(p) + (p.perDay === 'twice' ? '' : ' to 22:00')}${p.overdue === false ? '' : ', and daily when overdue'}`;
  // every reminder moment of one policy between two dates
  function occurrences(p, from, to) {
    const out = [], due = parseDay(p.nextDate); if (p.remind === false || !due || !settings().on) return out;
    const snooze = p.snoozeUntil ? new Date(p.snoozeUntil) : null, slots = slotsFor(p);
    const d = new Date(from); d.setHours(0, 0, 0, 0);
    for (; d <= to; d.setDate(d.getDate() + 1)) {
      const left = daysBetween(d, due); if (!dayWanted(p, left)) continue;
      for (const t of slots) {
        const at = new Date(d); at.setHours(Math.floor(t / 60), t % 60, 0, 0);
        if (at < from || at > to || (snooze && at < snooze)) continue;
        out.push({ at, left });
      }
    }
    if (snooze && snooze >= from && snooze <= to) out.push({ at: snooze, left: daysBetween(snooze, due), snoozed: true });
    return out.sort((a, b) => a.at - b.at);
  }
  const hashId = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 1000 + (Math.abs(h) % 2000000000); };
  const itemFor = (p, o) => ({
    id: hashId('ins:' + p.id + ':' + o.at.getTime()), key: `ins:${p.id}:${o.at.getTime()}`, group: 'ins:' + p.id, at: o.at, route: 'insurance', snooze: true, ref: p.id,
    title: `${o.left < 0 ? 'Overdue' : 'Renew'}: ${p.name}`,
    body: `${p.insurer ? p.insurer + ' · ' : ''}${leftText(o.left)} (${fmtDay(p.nextDate)})${p.number ? ' · ' + p.number : ''}${o.snoozed ? ' · snoozed reminder' : ''}`
  });
  // From the start of today to 45 days ahead (Android schedules the future ones with the OS; browsers show the latest past one)
  async function notificationItems() {
    if (!settings().on) return [];
    const from = new Date(); from.setHours(0, 0, 0, 0); const to = new Date(Date.now() + 45 * 864e5);
    const out = [];
    for (const p of await policies()) for (const o of occurrences(p, from, to)) out.push(itemFor(p, o));
    return out.sort((a, b) => a.at - b.at);
  }
  (window.DHNotifySources = window.DHNotifySources || []).push(notificationItems);
  const nextReminder = p => occurrences(p, new Date(), new Date(Date.now() + 400 * 864e5))[0];

  // ---- snooze: from the notification's buttons (Android and desktop Chrome/Edge) or from the policy card ----
  async function snooze(id, how) {
    const p = (await policies()).find(x => x.id === id); if (!p) return;
    let until = null;
    if (how === 'tomorrow') { const [h, m] = timeOf(p).split(':').map(Number); until = new Date(); until.setDate(until.getDate() + 1); until.setHours(h || 0, m || 0, 0, 0); }
    else if (SNOOZES[how]) until = new Date(Date.now() + SNOOZES[how][1]);
    const q = { ...p, snoozeUntil: until ? until.toISOString() : null };
    await savePolicy(q);
    // Schedule the snoozed reminder straight away (also while the app is locked with the fingerprint)
    const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications, PWR = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DevHubPower;
    // (the native engine gets the snoozed reminder from the resync instead)
    if (until && isNative() && LN && !(PWR && PWR.setReminders)) { try { const it = itemFor(q, { at: until, left: daysBetween(until, parseDay(q.nextDate)), snoozed: true }); await LN.schedule({ notifications: [{ id: it.id, title: it.title, body: it.body, channelId: 'devhub-reminders', actionTypeId: 'DH_SNOOZE', schedule: { at: until, allowWhileIdle: true }, extra: { route: 'insurance', ref: q.id, kind: 'ins' } }] }); } catch {} }
    if (document.body.dataset.route === 'insurance') render();
    toast(until ? `“${p.name}” snoozed until ${until.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : `Reminders for “${p.name}” resumed`);
  }
  // Snooze pressed in the Android notification bar while Toolbox+ was closed (native engine): just record it, quietly
  window.DHNotifyOnSnoozed = async (ref, until) => {
    const p = (await policies()).find(x => x.id === ref); if (!p || !until) return;
    if (p.snoozeUntil && new Date(p.snoozeUntil).getTime() >= until) return;
    p.snoozeUntil = new Date(until).toISOString(); p.updatedAt = new Date().toISOString();
    await idb.put('policies', p); cache = null;
    if (document.body.dataset.route === 'insurance') render();
  };
  // notification button pressed (notify.js forwards it): { action, ref }
  window.addEventListener('dh-notify-action', e => { const x = e.detail || {}; if (x.ref && (SNOOZES[x.action] || x.action === 'tomorrow')) snooze(x.ref, x.action); });
  // opened from a desktop notification button while Toolbox+ was closed: #insurance?nact=snooze60&ref=<policy id>
  function hashAction() {
    const q = new URLSearchParams(location.hash.split('?')[1] || ''), act = q.get('nact'), ref = q.get('ref');
    if (act && ref) { history.replaceState(null, '', '#insurance'); snooze(ref, act); }
  }

  // Outlook / Google / Apple calendar: a daily event with a reminder from N days before until the renewal date
  function icsFor(p) {
    const due = parseDay(p.nextDate), before = beforeOf(p), start = new Date(due); start.setDate(start.getDate() - before);
    const today = new Date(); today.setHours(0, 0, 0, 0); if (start < today) start.setTime(today.getTime());
    const [h, m] = (settings().time || '09:00').split(':').map(Number);
    const dt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const icsEsc = s => String(s || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DevHub//Insurance//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:devhub-ins-${p.id}-${p.nextDate}@devhub`, `DTSTAMP:${stamp}`,
      `DTSTART:${dt(start)}T${pad(h)}${pad(m)}00`, `DURATION:PT15M`, `RRULE:FREQ=DAILY;UNTIL=${dt(due)}T235959`,
      `SUMMARY:${icsEsc('Renew insurance: ' + p.name)}`,
      `DESCRIPTION:${icsEsc(`${p.insurer || ''}${p.number ? ' · Policy ' + p.number : ''}\nRenewal date: ${fmtDay(p.nextDate)}`)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc('Renew insurance: ' + p.name)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  /* ---------------- attachments ---------------- */
  async function openFile(f, download) {
    const rec = await idb.get('files', f.id); if (!rec) return toast('This attachment is missing on this device');
    const blob = rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob], { type: f.type });
    if (download || isNative()) return saveBlob(blob, f.name);   // Android: opens the share sheet → open with a PDF/image viewer or save
    const url = URL.createObjectURL(blob), w = window.open(url, '_blank', 'noopener');
    if (!w) saveBlob(blob, f.name);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  // ⤓ in the compact views: one document → download it; several → a small menu (each, or all)
  function downloadDocs(p, btn, view = false) {
    const files = p.files || []; if (!files.length) return;
    const act = f => view ? viewFile(f) : openFile(f, true);
    if (files.length === 1) return act(files[0]);
    document.querySelectorAll('.ins-dlmenu').forEach(m => m.remove());
    const m = document.createElement('div'); m.className = 'ins-dlmenu'; m.setAttribute('role', 'menu');
    m.innerHTML = files.map(f => `<button type="button" role="menuitem" data-f="${esc(f.id)}"><span class="ins-fi">${/pdf/i.test(f.type) ? 'PDF' : /image/i.test(f.type) ? 'IMG' : 'FILE'}</span><span class="ins-fname">${esc(f.name)}</span><span class="hint">${fmtSize(f.size || 0)}</span></button>`).join('') + (view ? '' : `<button type="button" role="menuitem" data-all class="ins-dlall">Download all ${files.length}</button>`);
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 16);
    m.style.width = w + 'px'; m.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px';
    const close = () => { m.remove(); document.removeEventListener('click', away, true); };
    const away = e => { if (!m.contains(e.target) && e.target !== btn) close(); };
    setTimeout(() => document.addEventListener('click', away, true), 0);
    m.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { close(); act(files.find(f => f.id === b.dataset.f)); });
    if (m.querySelector('[data-all]')) m.querySelector('[data-all]').onclick = async () => { close(); for (const f of files) { await openFile(f, true); await new Promise(r => setTimeout(r, 400)); } };
    const first = m.querySelector('button'); if (first) first.focus();
    m.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); btn.focus(); } });
  }

  /* ---------------- read policy PDFs (on this device, with the bundled pdf.js — nothing is uploaded) ---------------- */
  let pdfLib = null;
  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    pdfLib = new Promise((res, rej) => {
      if (window.pdfjsLib) return res(window.pdfjsLib);
      const s = document.createElement('script'); s.src = 'vendor/pdf.min.js';
      s.onload = () => { const L = window.pdfjsLib; if (!L) return rej(new Error('PDF reader did not load')); L.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; res(L); };
      s.onerror = () => { pdfLib = null; rej(new Error('PDF reader could not be loaded')); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }
  const isPdf = f => /pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name || '');
  async function openPdf(blob) {
    const L = await loadPdfJs();
    return L.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, disableFontFace: false, useSystemFonts: true, standardFontDataUrl: 'vendor/pdfjs-fonts/', useWorkerFetch: false }).promise;
  }
  // all text of the first pages, line by line (items on the same baseline are joined)
  async function pdfText(blob, maxPages = 12) {
    const doc = await openPdf(blob), out = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const tc = await (await doc.getPage(i)).getTextContent(), rows = new Map();
      for (const it of tc.items) { if (!it.str) continue; const y = Math.round(it.transform[5]); const k = [...rows.keys()].find(z => Math.abs(z - y) <= 2) ?? y; (rows.get(k) || rows.set(k, []).get(k)).push({ x: it.transform[4], s: it.str }); }
      [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => out.push(r.sort((a, b) => a.x - b.x).map(z => z.s).join(' ').replace(/\s+/g, ' ').trim()));
    }
    try { doc.destroy(); } catch {}
    return out.filter(Boolean).join('\n');
  }

  // ---- find the policy details in the text ----
  const INSURERS = ['Star Health', 'ICICI Lombard', 'HDFC ERGO', 'Bajaj Allianz', 'Bajaj General', 'Tata AIG', 'Niva Bupa', 'Max Bupa', 'Care Health', 'Religare', 'Aditya Birla', 'ManipalCigna', 'Manipal Cigna', 'New India Assurance', 'United India', 'Oriental Insurance', 'National Insurance', 'SBI General', 'Reliance General', 'Kotak Mahindra General', 'Zurich Kotak', 'Go Digit', 'Digit Insurance', 'Acko', 'Royal Sundaram', 'Cholamandalam', 'Chola MS', 'IFFCO Tokio', 'Future Generali', 'Generali Central', 'Liberty General', 'Magma HDI', 'Universal Sompo', 'Shriram General', 'Navi General', 'Raheja QBE', 'Edelweiss', 'Zuno',
    'Life Insurance Corporation', 'LIC of India', 'HDFC Life', 'SBI Life', 'Max Life', 'Axis Max Life', 'ICICI Prudential', 'Bajaj Allianz Life', 'Tata AIA', 'Kotak Life', 'PNB MetLife', 'Aditya Birla Sun Life', 'Canara HSBC', 'Aviva', 'Edelweiss Tokio', 'Bharti AXA', 'IndiaFirst', 'Pramerica', 'Shriram Life', 'Ageas Federal',
    'Allianz', 'AXA', 'Aviva', 'Zurich', 'Chubb', 'AIG', 'MetLife', 'Prudential', 'Cigna', 'Bupa', 'Aetna', 'Generali', 'Munich Re', 'Swiss Re'];
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const DATE_RX = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/. ](\d{1,2}|[A-Za-z]{3,9})[-/., ]+(\d{2,4})|([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/g;
  function toYmd(m) {
    let y, mo, d;
    if (m[1]) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if (m[4]) { d = +m[4]; y = +m[6]; if (y < 100) y += 2000; const v = m[5]; mo = /^\d+$/.test(v) ? +v - 1 : MONTHS[v.slice(0, 4).toLowerCase()] ?? MONTHS[v.slice(0, 3).toLowerCase()]; if (mo > 11 && d <= 12) { const t = d; d = mo + 1; mo = t - 1; } }   // dd/mm, or mm/dd when it can only be that
    else { mo = MONTHS[m[7].slice(0, 3).toLowerCase()]; d = +m[8]; y = +m[9]; }
    if (mo == null || !(mo >= 0 && mo <= 11) || !(d >= 1 && d <= 31) || !(y >= 1990 && y <= 2100)) return null;
    return `${y}-${pad(mo + 1)}-${pad(d)}`;
  }
  const datesIn = s => { const out = []; let m; DATE_RX.lastIndex = 0; while ((m = DATE_RX.exec(s))) { const v = toYmd(m); if (v) out.push(v); } return out; };
  // the date written on (or right after) a line that matches one of the labels
  function dateNear(lines, labels) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], hit = labels.find(rx => rx.test(l)); if (!hit) continue;
      const after = l.slice(l.search(hit)), ds = datesIn(after).concat(datesIn(lines[i + 1] || ''));
      if (ds.length) return ds;
    }
    return [];
  }
  function parsePolicy(text) {
    const lines = text.split('\n'), flat = lines.join(' '), out = {}, found = [];
    const pick = (k, v, label) => { if (v && !out[k]) { out[k] = String(v).trim(); found.push(label); } };
    // policy number
    const pn = flat.match(/(?:policy|certificate|cover\s*note)\s*(?:no|number|num|#)\.?\s*[:\-–]?\s*([A-Z0-9][A-Z0-9\/\-]{4,30})/i);
    if (pn && /\d/.test(pn[1])) pick('number', pn[1], 'policy number');
    // insurer
    const ins = INSURERS.find(n => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i').test(flat));
    if (ins) { const full = flat.match(new RegExp('(' + ins.replace(/\s+/g, '\\s+') + '[A-Za-z &.]{0,40}?(?:Insurance|Assurance)\\s*(?:Company|Co\\.?)?\\s*(?:Limited|Ltd\\.?)?)', 'i')); pick('insurer', full ? full[1].replace(/\s+/g, ' ') : ins, 'insurer'); }
    else { const co = flat.match(/([A-Z][A-Za-z&.]+(?: [A-Z][A-Za-z&.]+){0,5} (?:General |Life |Health )?(?:Insurance|Assurance) (?:Company|Co\.?)? ?(?:Limited|Ltd\.?))/); if (co) pick('insurer', co[1], 'insurer'); }
    // dates: period "from … to …", start, expiry / renewal / next due
    const period = flat.match(/(?:period\s+of\s+(?:insurance|cover)|policy\s+period|cover(?:age)?\s+period|valid(?:ity)?)[^\n]{0,40}?from\s*[:\-]?\s*(.{6,30}?)\s+(?:to|till|until|-)\s+(.{6,30}?)(?:\s|$)/i);
    let start = null, end = null;
    if (period) { start = datesIn(period[1])[0] || null; end = datesIn(period[2])[0] || null; }
    if (!start) start = dateNear(lines, [/(?:policy|risk|cover(?:age)?)\s*(?:start|commencement|inception|issue)\s*date/i, /date\s+of\s+(?:commencement|inception|issue)/i, /(?:start|effective)\s+date/i, /\bfrom\b\s*[:\-]?\s*\d/i])[0] || null;
    const due = dateNear(lines, [/next\s+(?:premium\s+)?due\s+date/i, /renewal\s+(?:due\s+)?date/i, /premium\s+due\s+date/i, /due\s+date\s+of\s+(?:next\s+)?premium/i]);
    if (!end) end = dateNear(lines, [/(?:policy\s+)?(?:expiry|expiration|end|maturity)\s+date/i, /date\s+of\s+(?:expiry|maturity)/i, /valid\s+(?:till|until|upto|up\s+to)/i, /\b(?:to|till|until)\b\s*[:\-]?\s*\d/i])[0] || null;
    if (start) pick('startDate', start, 'policy date');
    const next = due[0] || end;
    if (next && (!start || next > start)) pick('nextDate', next, due[0] ? 'next due date' : 'expiry date');
    // premium (prefer the total)
    const prem = flat.match(/(?:total|gross|final|net)\s+(?:annual\s+)?premium[^0-9₹]{0,40}?(?:₹|rs\.?|inr|`)?\s*([\d,]{3,}(?:\.\d{1,2})?)/i) || flat.match(/premium\s*(?:amount|payable|paid)?[^0-9₹]{0,30}?(?:₹|rs\.?|inr)\s*([\d,]{3,}(?:\.\d{1,2})?)/i);
    if (prem) pick('premium', '₹ ' + prem[1].replace(/\.00$/, ''), 'premium');
    // insured / proposer
    const HOLD_RX = /(?:name\s+of\s+(?:the\s+)?(?:insured|proposer|policy\s*holder|life\s+assured)|(?:insured|proposer|policy\s*holder|life\s+assured)(?:'s)?\s+name|policy\s*holder|proposer)\s*[:\-–]?\s*(.+)$/i;
    for (const l of lines) { const m = l.match(HOLD_RX); if (!m) continue; const v = m[1].replace(/\s{2,}.*$/, '').replace(/\b(?:address|age|dob|date of birth|gender|relationship|mobile|email|customer|client)\b.*$/i, '').trim(); if (/^[A-Za-z][A-Za-z .']{2,50}$/.test(v)) { pick('holder', v.replace(/\s+/g, ' '), 'holder'); break; } }
    // type
    const t = /mediclaim|health|hospitali[sz]ation|optima|family\s+floater/i.test(flat) ? 'Health'
      : /two[\s-]*wheeler|motor\s*cycle|scooter|bike/i.test(flat) ? 'Two-wheeler'
      : /private\s+car|motor|vehicle|car\s+insurance|registration\s+no/i.test(flat) ? 'Car'
      : /term\s+(?:plan|insurance|life)/i.test(flat) ? 'Term'
      : /life\s+(?:insurance|assured|cover)|endowment|ulip|sum\s+assured/i.test(flat) ? 'Life'
      : /travel|trip|overseas/i.test(flat) ? 'Travel'
      : /home|house(?:hold|holder)|property|fire/i.test(flat) ? 'Home' : null;
    if (t) pick('type', t, 'type');
    // a name for the policy: the product / plan name if written, otherwise "<insurer> <type>"
    let plan = null; for (const l of lines) { const m = l.match(/(?:product|plan|policy)\s*name\s*[:\-–]?\s*([A-Za-z0-9][A-Za-z0-9 &+\-().]{3,80})/i); if (m) { plan = [m[0], m[1].replace(/\s+(?:UIN|Code)\b.*$/i, '').trim()]; break; } }
    pick('name', plan ? plan[1].replace(/\s+/g, ' ') : [out.insurer && out.insurer.split(/\s+(?:general|life|health|insurance)/i)[0], out.type || 'insurance'].filter(Boolean).join(' '), 'name');
    return { fields: out, found };
  }

  // ---- read one document: text (PDF) → fields ----
  async function readDoc(blob, name) {
    if (!isPdf({ type: blob.type, name })) throw new Error('Only PDF documents can be read');
    const text = await pdfText(blob);
    if (text.replace(/\s/g, '').length < 40) throw Object.assign(new Error('This PDF has no readable text (it’s probably a scan or photo). Fill in the details yourself.'), { scanned: true });
    return { text, ...parsePolicy(text) };
  }

  /* ---------------- in-app document viewer (PDF pages, photos) ---------------- */
  async function viewFile(f) {
    const rec = await idb.get('files', f.id); if (!rec) return toast('This attachment is missing on this device');
    const blob = rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob], { type: f.type });
    return viewBlob(blob, f);
  }
  async function viewBlob(blob, f) {
    const img = /^image\//i.test(f.type || blob.type || ''), pdf = isPdf(f);
    if (!img && !pdf) return saveBlob(blob, f.name);
    const v = document.createElement('dialog'); v.className = 'ins-viewer';
    v.innerHTML = `<header><b title="${esc(f.name)}">${esc(f.name)}</b><span class="hint" id="ivInfo"></span>
        <span class="iv-acts">${pdf ? '<button type="button" class="ghost" id="ivOut" title="Zoom out">−</button><button type="button" class="ghost" id="ivIn" title="Zoom in">+</button>' : ''}<button type="button" class="ghost" id="ivDl" title="Download">&#8681; Download</button><button type="button" class="ghost" id="ivX" aria-label="Close">&#10005;</button></span></header>
      <div class="iv-body" id="ivBody"><p class="hint iv-wait">Opening…</p></div>`;
    document.body.appendChild(v); v.showModal();
    const close = () => { v.close(); v.remove(); if (url) URL.revokeObjectURL(url); }; let url = null;
    v.addEventListener('close', () => { v.remove(); if (url) URL.revokeObjectURL(url); });
    $('#ivX', v).onclick = close; $('#ivDl', v).onclick = () => saveBlob(blob, f.name);
    const body = $('#ivBody', v);
    if (img) { url = URL.createObjectURL(blob); body.innerHTML = `<img src="${url}" alt="${esc(f.name)}">`; return; }
    let doc, scale = 1;
    try { doc = await openPdf(blob); } catch (e) { body.innerHTML = `<p class="form-err">Couldn’t open this PDF (${esc(e.message)}). Use Download to open it in another app.</p>`; return; }
    $('#ivInfo', v).textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    const draw = async () => {
      body.innerHTML = ''; const w = Math.min(body.clientWidth - 24, 1000) || 600, dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 1; i <= doc.numPages && v.open; i++) {
        const page = await doc.getPage(i), base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (w / base.width) * scale * dpr });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.style.width = (vp.width / dpr) + 'px'; c.setAttribute('aria-label', `Page ${i}`);
        body.appendChild(c); await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    };
    $('#ivIn', v).onclick = () => { scale = Math.min(3, scale + 0.25); draw(); };
    $('#ivOut', v).onclick = () => { scale = Math.max(0.5, scale - 0.25); draw(); };
    draw();
  }

  /* ---------------- backup ---------------- */
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  async function exportAll() {
    const ps = await policies(), files = [];
    for (const p of ps) for (const f of p.files || []) { const rec = await idb.get('files', f.id); if (rec) files.push({ id: f.id, type: f.type, data: await b64(rec.blob) }); }
    const out = { app: 'devhub', type: 'devhub-insurance', version: 1, exportedAt: new Date().toISOString(), policies: ps, files };
    await saveBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `toolbox-plus-insurance-${ymd(new Date())}.json`);
  }
  async function importAll(file) {
    let j; try { j = JSON.parse(await file.text()); } catch { return toast('That file isn’t a Toolbox+ insurance backup'); }
    if (!j || j.type !== 'devhub-insurance' || !Array.isArray(j.policies)) return toast('That file isn’t a Toolbox+ insurance backup');
    const have = new Map((await policies()).map(p => [p.id, p])); let added = 0, updated = 0;
    for (const f of j.files || []) { const bin = atob(f.data), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); await idb.put('files', { id: f.id, blob: new Blob([a], { type: f.type || '' }) }); }
    for (const p of j.policies) { const cur = have.get(p.id); if (cur && String(cur.updatedAt) >= String(p.updatedAt)) continue; await idb.put('policies', p); cur ? updated++ : added++; }
    cache = null; resync(); render(); toast(`Imported: ${added} new, ${updated} updated`);
  }

  /* ---------------- page ---------------- */
  let query = '';
  async function render() {
    const host = view(); if (document.body.dataset.route !== 'insurance') return;
    const ps = (await policies()).slice().sort((a, b) => String(a.nextDate || '9999').localeCompare(String(b.nextDate || '9999')));
    if (document.body.dataset.route !== 'insurance') return;
    const q = query.toLowerCase(), shown = ps.filter(p => !q || [p.name, p.holder, p.insurer, p.number, p.type, p.notes, p.docText].join(' ').toLowerCase().includes(q));
    const st = ps.map(p => state(p)), over = st.filter(s => s.kind === 'overdue').length, soon = st.filter(s => s.kind === 'soon' || s.kind === 'today').length;
    const s = settings(), perm = window.DHNotify ? await window.DHNotify.permission() : 'unsupported';
    const dens = DH.density ? DH.density.get('insurance') : 3;
    const nextAlert = p => { const n = p.remind !== false && s.on ? nextReminder(p) : null; return n ? n.at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; };
    const snoozedTxt = p => p.snoozeUntil && new Date(p.snoozeUntil) > new Date() ? 'Snoozed until ' + new Date(p.snoozeUntil).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    // compact rows: one line, or two lines; ⤓ downloads the policy document(s); ⋯ has every action
    const rowHtml = (p, d) => {
      const n = (p.files || []).length, sz = snoozedTxt(p), na = nextAlert(p);
      const meta = [p.insurer, p.number ? 'No. ' + p.number : '', 'Next ' + fmtDay(p.nextDate)].filter(Boolean).join(' · ');
      const meta2 = [p.holder, p.premium, sz || (na ? 'Next alert ' + na : '')].filter(Boolean).join(' · ');
      return `<article class="ins-row ${state(p).kind}" data-id="${esc(p.id)}">
        <span class="ins-bar" aria-hidden="true"></span>
        <div class="ins-r-main"><div class="ins-r-l1"><span class="ins-type">${esc(p.type || 'Other')}</span><b class="ins-r-name">${esc(p.name)}</b>${d === 1 ? `<span class="ins-r-meta">${esc(meta)}</span>` : ''}</div>
          ${d === 2 ? `<div class="ins-r-l2">${esc(meta)}${meta2 ? `<span class="ins-r-sub"> · ${esc(meta2)}</span>` : ''}</div>` : ''}</div>
        ${pill(p)}
        <button type="button" class="ins-dlbtn" data-dlall ${n ? '' : 'disabled'} title="${n ? (n === 1 ? 'Download ' + esc(p.files[0].name) : 'Download policy documents (' + n + ')') : 'No document attached'}" aria-label="Download policy document"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>${n > 1 ? `<span class="ins-dln">${n}</span>` : ''}</button>
        <select class="ins-more" data-act aria-label="Actions for ${esc(p.name)}"><option value="">&#8943;</option><option value="edit">Edit</option>${n ? `<option value="view">View document${n > 1 ? 's…' : ''}</option>` : ''}${p.nextDate ? '<option value="renew">Mark renewed…</option>' : ''}${p.remind !== false ? `<optgroup label="Snooze">${Object.entries(SNOOZES).map(([k, v]) => `<option value="snz:${k}">${v[0]}</option>`).join('')}${sz ? '<option value="snz:resume">Resume now</option>' : ''}</optgroup>` : ''}${p.nextDate ? '<option value="ics">Add to calendar</option>' : ''}<option value="del">Delete</option></select>
      </article>`;
    };
    const pill = p => { const x = state(p); return x.kind === 'none' ? '' : `<span class="ins-pill ${x.kind}">${x.kind === 'later' ? 'Renews ' + fmtDay(p.nextDate) : leftText(x.left).replace(/^./, c => c.toUpperCase())}</span>`; };
    host.innerHTML = `<h1>Insurance</h1><p class="lede">Your policies, their documents and renewal reminders. Stored only on this device — works offline, no account and no server.</p>
      <div class="ins-stats"><span><b>${ps.length}</b> polic${ps.length === 1 ? 'y' : 'ies'}</span><span class="${soon ? 'soon' : ''}"><b>${soon}</b> due within reminder window</span><span class="${over ? 'overdue' : ''}"><b>${over}</b> overdue</span></div>
      ${perm !== 'granted' && s.on ? `<div class="nt-banner"><span>&#128276; ${perm === 'denied' ? 'Notifications are blocked for Toolbox+, so renewal reminders can’t be shown. Allow them in your ' + (isNative() ? 'phone’s Settings → Apps → Toolbox+.' : 'browser’s site settings.') : perm === 'unsupported' ? 'This browser can’t show notifications — use “Add to calendar” on each policy, or the Android app.' : 'Allow notifications so Toolbox+ can remind you every day before a renewal.'}</span>${perm === 'default' ? '<span><button type="button" class="primary" id="insAllow">Allow notifications</button></span>' : ''}</div>` : ''}
      ${(() => {
        const now = new Date(), to = new Date(Date.now() + 60 * 864e5), up = [];
        for (const p of ps) { const o = occurrences(p, now, to)[0]; if (o) up.push({ p, o }); }
        up.sort((a, b) => a.o.at - b.o.at);
        return up.length ? `<section class="ins-up"><h2>Next reminders <span class="hint">one per policy, each on its own schedule</span></h2><ol>${up.slice(0, 8).map(({ p, o }) => `<li><time>${esc(o.at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</time><span><b>${esc(p.name)}</b> · ${esc(leftText(o.left))}${o.snoozed ? ' · snoozed' : ''}</span></li>`).join('')}</ol></section>` : '';
      })()}
      <div class="links-bar"><input id="insQ" type="search" placeholder="Search policies" value="${esc(query)}" aria-label="Search policies">
        <button class="primary" id="insNew">Add policy</button><button id="insPdf" title="Pick a policy PDF — Toolbox+ reads the name, insurer, policy number, dates and premium from it (on this device)">&#128196; Add from PDF</button><input type="file" id="insPdfF" accept="application/pdf,.pdf" hidden><button id="insSet">Reminders…</button><button id="insExp" ${ps.length ? '' : 'disabled'}>Export</button><button id="insImp">Import</button><input type="file" id="insImpF" accept=".json,application/json" hidden>${DH.density ? DH.density.bar('insurance') : ''}</div>
      ${dens < 3 ? `<div class="ins-list dens-${dens}">${shown.map(p => rowHtml(p, dens)).join('')}</div>` : ''}
      <div class="ins-grid" ${dens < 3 ? 'hidden' : ''}>${dens < 3 ? '' : shown.map(p => `<article class="ins-card ${state(p).kind}" data-id="${esc(p.id)}">
        <header><div><span class="ins-type">${esc(p.type || 'Other')}</span><h2>${esc(p.name)}</h2>${p.holder ? `<p class="hint">${esc(p.holder)}</p>` : ''}</div>${pill(p)}</header>
        <dl class="kv2"><dt>Insurer</dt><dd>${esc(p.insurer || '—')}</dd><dt>Policy no.</dt><dd class="mono">${esc(p.number || '—')}</dd>
          <dt>Policy date</dt><dd>${fmtDay(p.startDate)}</dd><dt>Next date</dt><dd><b>${fmtDay(p.nextDate)}</b></dd>
          ${p.premium ? `<dt>Premium</dt><dd>${esc(p.premium)}</dd>` : ''}
          <dt>Reminder</dt><dd>${esc(ruleText(p))}</dd>
          ${p.remind !== false && s.on ? `<dt>Next alert</dt><dd>${(() => { const n = nextReminder(p); return n ? esc(n.at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '—'; })()}</dd>` : ''}</dl>
        ${p.snoozeUntil && new Date(p.snoozeUntil) > new Date() ? `<p class="ins-snoozed">&#128564; Snoozed until ${esc(new Date(p.snoozeUntil).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} <button type="button" class="ghost" data-unsnooze>Resume now</button></p>` : ''}
        ${p.notes ? `<p class="ins-notes">${esc(p.notes)}</p>` : ''}
        ${(p.files || []).length ? `<ul class="ins-files">${p.files.map(f => `<li><span class="ins-fi" aria-hidden="true">${/pdf/i.test(f.type) ? 'PDF' : /image/i.test(f.type) ? 'IMG' : 'FILE'}</span><button type="button" class="ghost ins-fname" data-open="${esc(f.id)}" title="Open">${esc(f.name)}</button><span class="hint">${fmtSize(f.size || 0)}</span><button type="button" class="ghost" data-dl="${esc(f.id)}" title="Download">&#8681;</button></li>`).join('')}</ul>` : '<p class="hint">No attachment yet.</p>'}
        <div class="row ins-acts"><button data-edit>Edit</button><button data-renew ${p.nextDate ? '' : 'disabled'}>Mark renewed…</button>${p.remind !== false ? `<select data-snooze aria-label="Snooze reminders"><option value="">Snooze…</option>${Object.entries(SNOOZES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>` : ''}<button data-ics ${p.nextDate ? '' : 'disabled'} title="Daily reminder series for Outlook / Google Calendar">Add to calendar</button><button class="danger" data-del>Delete</button></div>
      </article>`).join('')}</div>
      ${shown.length ? '' : `<p class="empty">${ps.length ? 'No policies match that search.' : 'No policies yet. Add your first one — name, policy date, next renewal date and the policy document.'}</p>`}`;
    $('#insQ').oninput = e => { query = e.target.value; const pos = e.target.selectionStart; render().then(() => { const i = $('#insQ'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); };
    $('#insNew').onclick = () => edit(null);
    $('#insPdf').onclick = () => $('#insPdfF').click();
    $('#insPdfF').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      if (f.size > 40 * 1048576) return toast(`${f.name} is larger than 40 MB`);
      const b = $('#insPdf'); b.disabled = true; b.textContent = 'Reading PDF…';
      let r; try { r = await readDoc(f, f.name); } catch (x) { r = { fields: {}, found: [], error: x.message }; }
      b.disabled = false; b.innerHTML = '&#128196; Add from PDF';
      edit(null, { ...r, file: f });
    };
    $('#insSet').onclick = remindersDialog;
    $('#insExp').onclick = () => exportAll().catch(e => toast('Export failed: ' + e.message));
    $('#insImp').onclick = () => $('#insImpF').click();
    $('#insImpF').onchange = e => { const f = e.target.files[0]; if (f) importAll(f); e.target.value = ''; };
    const allow = $('#insAllow'); if (allow) allow.onclick = async () => { await window.DHNotify.request(); resync(); render(); };
    if (DH.density) DH.density.wire('insurance', render);
    const delPolicy = async p => {
      if (!confirm(`Delete “${p.name}” and its ${(p.files || []).length} attachment(s) from this device?`)) return;
      for (const f of p.files || []) await idb.del('files', f.id).catch(() => {});
      await idb.del('policies', p.id); cache = null; resync(); render(); toast(`Deleted “${p.name}”`);
    };
    const icsOf = p => saveBlob(new Blob([icsFor(p)], { type: 'text/calendar' }), `renew-${p.name.replace(/[^\w-]+/g, '-').toLowerCase()}.ics`);
    host.querySelectorAll('.ins-row').forEach(row => {
      const p = ps.find(x => x.id === row.dataset.id);
      $('[data-dlall]', row).onclick = e => downloadDocs(p, e.currentTarget);
      $('.ins-r-main', row).onclick = () => edit(p);
      const a = $('[data-act]', row);
      a.onchange = () => {
        const v = a.value; a.value = '';
        if (v === 'edit') edit(p); else if (v === 'view') downloadDocs(p, $('[data-dlall]', row), true); else if (v === 'renew') renew(p); else if (v === 'ics') icsOf(p); else if (v === 'del') delPolicy(p);
        else if (v === 'snz:resume') snooze(p.id, null); else if (v.startsWith('snz:')) snooze(p.id, v.slice(4));
      };
    });
    host.querySelectorAll('.ins-card').forEach(card => {
      const p = ps.find(x => x.id === card.dataset.id), fileOf = id => (p.files || []).find(f => f.id === id);
      card.querySelectorAll('[data-open]').forEach(b => b.onclick = () => viewFile(fileOf(b.dataset.open)));
      card.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => openFile(fileOf(b.dataset.dl), true));
      $('[data-edit]', card).onclick = () => edit(p);
      $('[data-renew]', card).onclick = () => renew(p);
      const sz = $('[data-snooze]', card); if (sz) sz.onchange = () => { if (sz.value) snooze(p.id, sz.value); };
      const us = $('[data-unsnooze]', card); if (us) us.onclick = () => snooze(p.id, null);
      $('[data-ics]', card).onclick = () => saveBlob(new Blob([icsFor(p)], { type: 'text/calendar' }), `renew-${p.name.replace(/[^\w-]+/g, '-').toLowerCase()}.ics`);
      $('[data-del]', card).onclick = async () => {
        if (!confirm(`Delete “${p.name}” and its ${(p.files || []).length} attachment(s) from this device?`)) return;
        for (const f of p.files || []) await idb.del('files', f.id).catch(() => {});
        await idb.del('policies', p.id); cache = null; resync(); render(); toast(`Deleted “${p.name}”`);
      };
    });
  }

  function dialog(html) {
    let d = $('#insDlg'); if (!d) { d = document.createElement('dialog'); d.id = 'insDlg'; d.className = 'tk-dialog ins-dlg'; document.body.appendChild(d); }
    d.innerHTML = html; if (!d.open) d.showModal(); return d;
  }

  // init (optional, from "Add from PDF"): { fields, found, file, text, error }
  function edit(p, init) {
    const isNew = !p; p = p ? JSON.parse(JSON.stringify(p)) : { id: uid(), files: [], remind: true, daysBefore: 30, type: 'Health', createdAt: new Date().toISOString() };
    if (init && init.fields) Object.assign(p, init.fields);
    if (init && init.text) p.docText = init.text.slice(0, 20000);
    const pending = [];   // new files chosen in this dialog: { meta, blob }
    if (init && init.file) pending.push({ meta: { id: uid(), name: init.file.name, type: init.file.type || 'application/pdf', size: init.file.size, addedAt: new Date().toISOString() }, blob: init.file });
    const removed = new Set();
    const d = dialog(`<form method="dialog" id="insF" novalidate>
      <header class="tk-dlg-head"><h2>${isNew ? 'Add policy' : 'Edit policy'}</h2><button class="ghost dr-x" value="cancel" formnovalidate aria-label="Close">&#10005;</button></header>
      ${init ? `<p class="ins-read-note ${init.error ? 'warn' : ''}" id="iReadNote">${init.error ? '&#9888; ' + esc(init.error) : init.found.length ? `&#10024; Read from <b>${esc(init.file.name)}</b>: ${esc(init.found.join(', '))}. Please check them — highlighted fields were filled in from the PDF.` : `Nothing recognisable was found in <b>${esc(init.file.name)}</b>. Fill in the details yourself.`}</p>` : '<p class="ins-read-note" id="iReadNote" hidden></p>'}
      <label for="iName">Policy name *</label><input id="iName" required value="${esc(p.name || '')}" placeholder="e.g. Family health cover">
      <div class="ins-2"><div><label for="iType">Type</label><select id="iType">${TYPES.map(t => `<option ${t === p.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label for="iHolder">Insured / holder name</label><input id="iHolder" value="${esc(p.holder || '')}"></div></div>
      <div class="ins-2"><div><label for="iIns">Insurer</label><input id="iIns" value="${esc(p.insurer || '')}"></div>
        <div><label for="iNum">Policy number</label><input id="iNum" value="${esc(p.number || '')}"></div></div>
      <div class="ins-2"><div><label for="iStart">Policy date</label><input id="iStart" type="date" value="${esc(p.startDate || '')}"></div>
        <div><label for="iNext">Next date (renewal / due) *</label><input id="iNext" type="date" required value="${esc(p.nextDate || '')}"></div></div>
      <label for="iPrem">Premium</label><input id="iPrem" value="${esc(p.premium || '')}" placeholder="optional, e.g. ₹ 24,500 / year">
      <fieldset class="ins-rep"><legend><label class="ins-check"><input type="checkbox" id="iRem" ${p.remind === false ? '' : 'checked'}> Reminders</label></legend>
        <div class="ins-2"><div><label for="iMode">Start reminding</label><select id="iMode"><option value="days" ${p.startMode === 'date' ? '' : 'selected'}>Days before the next date</option><option value="date" ${p.startMode === 'date' ? 'selected' : ''}>From a date</option></select>
            <input id="iDays" type="number" min="0" max="365" value="${p.daysBefore ?? 30}" aria-label="Days before the next date" ${p.startMode === 'date' ? 'hidden' : ''}>
            <input id="iFrom" type="date" value="${esc(p.remindFrom || '')}" aria-label="Start reminding on" ${p.startMode === 'date' ? '' : 'hidden'}></div>
          <div><label for="iTime">Time</label><input id="iTime" type="time" value="${esc(timeOf(p))}"></div></div>
        <div class="ins-2"><div><label for="iRule">Repeat on</label><select id="iRule">${Object.entries(DAY_RULES).map(([k, v]) => `<option value="${k}" ${k === (p.days || 'daily') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div><label for="iPer">Each of those days</label><select id="iPer">${Object.entries(PER_DAY).map(([k, v]) => `<option value="${k}" ${k === (p.perDay || 'once') ? 'selected' : ''}>${v.replace(/^./, c => c.toUpperCase())}</option>`).join('')}</select></div></div>
        <div id="iCustomRow" ${p.days === 'custom' ? '' : 'hidden'}><label for="iCustom">Days before the next date</label><input id="iCustom" value="${esc(p.customDays || '30,15,7,3,1,0')}" placeholder="30,15,7,3,1,0"></div>
        <label class="ins-check"><input type="checkbox" id="iOver" ${p.overdue === false ? '' : 'checked'}> Keep reminding every day after the next date until marked renewed</label>
        <p class="hint" id="iPreview"></p></fieldset>
      <label>Policy documents</label><div id="iFiles" class="ins-files edit"></div>
      <label class="ins-drop"><input type="file" id="iFile" multiple accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.txt,.eml,.msg"><span>Choose or drop files (PDF, photos…)</span></label>
      <label for="iNotes">Notes</label><textarea id="iNotes" rows="2">${esc(p.notes || '')}</textarea>
      <p class="form-err" id="iErr" hidden></p>
      <footer class="nt-foot"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok" id="iSave">Save policy</button></footer></form>`);
    const drawFiles = () => {
      const list = [...(p.files || []).filter(f => !removed.has(f.id)), ...pending.map(x => x.meta)];
      $('#iFiles', d).innerHTML = list.length ? list.map(f => `<li><span class="ins-fi">${/pdf/i.test(f.type) ? 'PDF' : /image/i.test(f.type) ? 'IMG' : 'FILE'}</span><button type="button" class="ghost ins-fname" data-viewf="${esc(f.id)}" title="View">${esc(f.name)}</button><span class="hint">${fmtSize(f.size)}</span>${isPdf(f) ? `<button type="button" class="ghost ins-readbtn" data-readf="${esc(f.id)}" title="Read the policy details from this PDF">Read details</button>` : ''}<button type="button" class="ghost danger" data-rmf="${esc(f.id)}" aria-label="Remove ${esc(f.name)}">&#10005;</button></li>`).join('') : '<li class="hint">No documents attached.</li>';
      const blobOf = async id => { const x = pending.find(y => y.meta.id === id); if (x) return { blob: x.blob, meta: x.meta }; const meta = (p.files || []).find(f => f.id === id), rec = await idb.get('files', id); return rec ? { blob: rec.blob, meta } : null; };
      d.querySelectorAll('[data-viewf]').forEach(b => b.onclick = async () => { const r = await blobOf(b.dataset.viewf); if (r) viewBlob(r.blob, r.meta); });
      d.querySelectorAll('[data-readf]').forEach(b => b.onclick = async () => {
        const r = await blobOf(b.dataset.readf); if (!r) return;
        b.disabled = true; b.textContent = 'Reading…';
        try { const res = await readDoc(r.blob, r.meta.name); fillFrom(res, r.meta.name); }
        catch (e) { const n = $('#iReadNote', d); n.hidden = false; n.className = 'ins-read-note warn'; n.innerHTML = '&#9888; ' + esc(e.message); }
        finally { b.disabled = false; b.textContent = 'Read details'; }
      });
      d.querySelectorAll('[data-rmf]').forEach(b => b.onclick = () => { const id = b.dataset.rmf, i = pending.findIndex(x => x.meta.id === id); if (i >= 0) pending.splice(i, 1); else removed.add(id); drawFiles(); });
    };
    // put what was read into the form: empty fields only, unless you agree to replace what's there
    const FIELD_INPUT = { name: '#iName', type: '#iType', holder: '#iHolder', insurer: '#iIns', number: '#iNum', startDate: '#iStart', nextDate: '#iNext', premium: '#iPrem' };
    const fillFrom = (res, fname) => {
      const f = res.fields, keys = Object.keys(f).filter(k => FIELD_INPUT[k]);
      const clash = keys.filter(k => { const el = $(FIELD_INPUT[k], d); return el.value && el.value !== f[k] && !(k === 'type' && el.value === 'Health' && isNew); });
      const replace = clash.length ? confirm(`The PDF has different values for: ${clash.join(', ')}.\n\nOK = replace them with the PDF’s values\nCancel = keep what you typed (only empty fields are filled)`) : false;
      const filled = [];
      for (const k of keys) { const el = $(FIELD_INPUT[k], d); if (!el.value || replace || (k === 'type' && isNew)) { if (el.value !== f[k]) { el.value = f[k]; el.classList.add('ins-filled'); filled.push(k); } } }
      p.docText = res.text.slice(0, 20000);
      const n = $('#iReadNote', d); n.hidden = false; n.className = 'ins-read-note';
      n.innerHTML = res.found.length ? `&#10024; Read from <b>${esc(fname)}</b>: ${esc(res.found.join(', '))}. ${filled.length ? 'Highlighted fields were filled in — please check them.' : 'Nothing new to fill in.'}` : `Nothing recognisable was found in <b>${esc(fname)}</b>.`;
      preview();
    };
    drawFiles();
    if (init && init.fields) Object.keys(init.fields).forEach(k => { const el = FIELD_INPUT[k] && $(FIELD_INPUT[k], d); if (el) el.classList.add('ins-filled'); });
    d.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => el.classList.remove('ins-filled')));
    const draft = () => ({ remind: $('#iRem', d).checked, nextDate: $('#iNext', d).value, startMode: $('#iMode', d).value, remindFrom: $('#iFrom', d).value, daysBefore: parseInt($('#iDays', d).value, 10) >= 0 ? parseInt($('#iDays', d).value, 10) : 30, time: $('#iTime', d).value, days: $('#iRule', d).value, perDay: $('#iPer', d).value, customDays: $('#iCustom', d).value, overdue: $('#iOver', d).checked });
    const preview = () => {
      $('#iCustomRow', d).hidden = $('#iRule', d).value !== 'custom';
      const byDate = $('#iMode', d).value === 'date'; $('#iDays', d).hidden = byDate; $('#iFrom', d).hidden = !byDate;
      if (byDate && !$('#iFrom', d).value && $('#iNext', d).value) { const f = parseDay($('#iNext', d).value); f.setDate(f.getDate() - 30); $('#iFrom', d).value = ymd(f); }
      const q = draft(), o = q.nextDate ? occurrences(q, new Date(), new Date(Date.now() + 400 * 864e5)) : [];
      $('#iPreview', d).textContent = !q.remind ? 'No reminders for this policy.' : !q.nextDate ? 'Choose the next date to see when you’ll be reminded.'
        : o.length ? `${ruleText(q)}. First alert ${o[0].at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${o.filter(x => x.left >= 0).length} alert${o.filter(x => x.left >= 0).length === 1 ? '' : 's'} up to the next date.` : 'No alerts left before the next date with these settings.';
    };
    d.querySelectorAll('#iRem, #iNext, #iMode, #iDays, #iFrom, #iTime, #iRule, #iPer, #iCustom, #iOver').forEach(i => { i.oninput = preview; i.onchange = preview; });
    preview();
    const add = files => { for (const f of files) { if (f.size > 40 * 1048576) { toast(`${f.name} is larger than 40 MB — not added`); continue; } pending.push({ meta: { id: uid(), name: f.name, type: f.type || '', size: f.size, addedAt: new Date().toISOString() }, blob: f }); } drawFiles(); };
    $('#iFile', d).onchange = e => { add([...e.target.files]); e.target.value = ''; };
    const drop = $('.ins-drop', d);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); add([...e.dataTransfer.files]); };
    $('#iSave', d).onclick = async e => {
      e.preventDefault();
      const name = $('#iName', d).value.trim(), next = $('#iNext', d).value, err = $('#iErr', d);
      if ($('#iMode', d).value === 'date' && (!$('#iFrom', d).value || $('#iFrom', d).value > next)) { err.textContent = 'Choose a start date on or before the next date.'; err.hidden = false; return; }
      if (!name || !next) { err.textContent = !name ? 'Enter the policy name.' : 'Choose the next date — reminders are based on it.'; err.hidden = false; return; }
      Object.assign(p, { name, type: $('#iType', d).value, holder: $('#iHolder', d).value.trim(), insurer: $('#iIns', d).value.trim(), number: $('#iNum', d).value.trim(),
        startDate: $('#iStart', d).value, nextDate: next, premium: $('#iPrem', d).value.trim(), remind: $('#iRem', d).checked,
        daysBefore: Math.min(365, Math.max(0, parseInt($('#iDays', d).value, 10) >= 0 ? parseInt($('#iDays', d).value, 10) : 30)), time: $('#iTime', d).value || settings().time, startMode: $('#iMode', d).value, remindFrom: $('#iFrom', d).value,
        days: $('#iRule', d).value, perDay: $('#iPer', d).value, customDays: customDays({ customDays: $('#iCustom', d).value }).join(','), overdue: $('#iOver', d).checked, snoozeUntil: p.nextDate === next ? p.snoozeUntil : null,
        notes: $('#iNotes', d).value.trim() });
      try {
        for (const x of pending) await idb.put('files', { id: x.meta.id, blob: x.blob });
        for (const id of removed) await idb.del('files', id).catch(() => {});
        p.files = [...(p.files || []).filter(f => !removed.has(f.id)), ...pending.map(x => x.meta)];
        await savePolicy(p);
      } catch (x) { err.textContent = 'Couldn’t save on this device: ' + (x && x.message || 'storage is full'); err.hidden = false; return; }
      d.close(); render(); toast(isNew ? 'Policy added — reminders are set' : 'Policy saved');
    };
  }

  function renew(p) {
    const cur = parseDay(p.nextDate) || new Date(), nx = new Date(cur); nx.setFullYear(nx.getFullYear() + 1);
    const d = dialog(`<form method="dialog"><header class="tk-dlg-head"><h2>Mark “${esc(p.name)}” renewed</h2><button class="ghost dr-x" value="cancel" aria-label="Close">&#10005;</button></header>
      <p class="hint">Reminders stop for ${fmtDay(p.nextDate)} and start again before the new date.</p>
      <label for="rNext">New next date</label><input id="rNext" type="date" value="${ymd(nx)}">
      <label class="ins-check"><input type="checkbox" id="rStart" checked> Set the policy date to ${fmtDay(p.nextDate)}</label>
      <p class="hint">Tip: attach the new policy document with Edit.</p>
      <footer class="nt-foot"><button value="cancel">Cancel</button><button class="primary" value="ok" id="rOk">Save</button></footer></form>`);
    $('#rOk', d).onclick = async e => {
      e.preventDefault(); const v = $('#rNext', d).value; if (!v) return;
      const q = { ...p, history: [...(p.history || []), { date: p.nextDate, renewedAt: new Date().toISOString() }], nextDate: v };
      if ($('#rStart', d).checked) q.startDate = p.nextDate;
      await savePolicy(q); d.close(); render(); toast(`Next date set to ${fmtDay(v)}`);
    };
  }

  async function remindersDialog() {
    const s = settings(), N = window.DHNotify, perm = N ? await N.permission() : 'unsupported';
    const d = dialog(`<form method="dialog"><header class="tk-dlg-head"><h2>Renewal reminders</h2><button class="ghost dr-x" value="cancel" aria-label="Close">&#10005;</button></header>
      <label class="ins-check"><input type="checkbox" id="sOn" ${s.on ? 'checked' : ''}> Daily renewal reminders</label>
      <label for="sTime">Default time for new policies</label><input id="sTime" type="time" value="${esc(s.time)}">
      <p class="hint">Each policy has its own repetition (which days, how often a day, after the due date) — set it with Edit. Every reminder has <b>Snooze</b> buttons: 15 minutes, 1 hour or tomorrow.</p>
      <p class="hint">Notifications: <b>${perm === 'granted' ? 'allowed' : perm === 'denied' ? 'blocked' : perm === 'unsupported' ? 'not supported here' : 'not asked yet'}</b>.
        ${isNative() ? 'Reminders are scheduled with Android’s alarm manager (exact alarms, allowed in battery-saving mode) for the next 45 days, so they arrive when Toolbox+ is closed or swiped away and after a restart. Opening Toolbox+ tops them up.' : 'In a browser, reminders appear while Toolbox+ is open in a tab or installed as an app. For reminders with the browser closed, use “Add to calendar” on each policy (Outlook / Google Calendar) or the Android app.'}</p>
      ${isNative() ? '<p><button type="button" id="sRel">Battery &amp; background permissions…</button></p>' : ''}
      <footer class="nt-foot">${perm === 'default' ? '<button type="button" id="sAsk">Allow notifications</button>' : ''}<button type="button" id="sTest" ${perm === 'granted' ? '' : 'disabled'}>Test now</button><button class="primary" value="ok" id="sOk">Save</button></footer></form>`);
    const sr = $('#sRel', d); if (sr) sr.onclick = () => { d.close(); N.reliability(); };
    const ask = $('#sAsk', d); if (ask) ask.onclick = async () => { await N.request(); d.close(); remindersDialog(); };
    $('#sTest', d).onclick = async () => {
      const items = await notificationItems(); const it = items[0] || { title: 'Toolbox+ insurance', body: 'Renewal reminders are working on this device.' };
      const PWR = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DevHubPower;
      if (isNative() && PWR && PWR.showNow) { await PWR.showNow({ title: it.title, body: it.body, ref: it.ref || '', route: 'insurance' }); toast('Sent — pull down the notification bar and try Snooze'); return; }
      await N.show(it.title, it.body, { tag: 'ins-test', route: 'insurance', ref: it.ref, snooze: !!it.ref });
    };
    $('#sOk', d).onclick = e => { e.preventDefault(); setSettings({ on: $('#sOn', d).checked, time: $('#sTime', d).value || '09:00' }); d.close(); render(); toast('Reminder settings saved'); };
  }

  routes.insurance = () => { view().innerHTML = '<h1>Insurance</h1><p class="lede">Loading…</p>'; hashAction(); render(); };
  window.DHInsurance = { notificationItems, policies, render, snooze, occurrences, parsePolicy, readDoc };
})();
