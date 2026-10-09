/* DevHub notifications -- reminders on desktop browsers and the Android app.
 *
 *  Android app : @capacitor/local-notifications. Notifications are scheduled with the OS alarm manager, so they
 *                arrive even when the app is closed. The app REQUIRES the notification permission (Android 13+) and
 *                the exact-alarm permission (Android 12+): a blocking prompt stays up until both are granted.
 *  Desktop/web : the Web Notifications API. Permission is requested from a button click (browsers ignore or punish
 *                prompts that appear without a user gesture). Reminders fire while DevHub is open in a tab or
 *                installed as an app; browsers cannot wake a closed page, so the Android app is the choice for that.
 *
 * What triggers a notification
 *   - a task's own "Remind me" date and time (task.remind, local "YYYY-MM-DDTHH:mm")
 *   - a daily summary at a time you choose: tasks due today and overdue tasks
 *   - a heads-up when a task is due today but has no reminder time (part of the daily summary)
 */
(() => {
  'use strict';
  const KEY = 'devhub:notify', FIRED = 'devhub:notify-fired';
  const DEFAULTS = { on: true, digest: true, digestTime: '09:00', sound: true };
  const CHANNEL = 'devhub-reminders';
  const DIGEST_DAYS = 7;                               // daily summaries scheduled ahead on Android
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const LN = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const prefs = () => ({ ...DEFAULTS, ...read(KEY, {}) });
  const setPrefs = p => { write(KEY, { ...prefs(), ...p }); sync(); };
  const pad = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const tasksDoc = () => { try { const d = window.DH && window.DH.data.get('tasks'); return d && Array.isArray(d.tasks) ? d : null; } catch { return null; } };
  const live = d => d.tasks.filter(t => !t.deleted && t.status !== 'done');
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 1000 + (Math.abs(h) % 2000000000); }; // ids 1..DIGEST_DAYS are the summaries
  const when = r => { const t = new Date(r); return isNaN(t) ? null : t; };

  /* ---------------- permission ---------------- */
  // 'granted' | 'denied' | 'default' | 'unsupported'
  async function permission() {
    if (isNative()) {
      const p = LN(); if (!p) return 'unsupported';
      try { const r = await p.checkPermissions(); return r.display === 'granted' ? 'granted' : r.display === 'denied' ? 'denied' : 'default'; } catch { return 'unsupported'; }
    }
    return 'Notification' in window ? Notification.permission : 'unsupported';
  }
  // Android 12+: reminders at the exact minute need "Alarms & reminders". 'granted' elsewhere.
  async function exactAlarm() {
    if (!isNative()) return 'granted';
    const p = LN(); if (!p || !p.checkExactNotificationSetting) return 'granted';
    try { const r = await p.checkExactNotificationSetting(); return r.exact_alarm === 'granted' ? 'granted' : 'denied'; } catch { return 'granted'; }
  }
  async function request() {
    if (isNative()) {
      const p = LN(); if (!p) return 'unsupported';
      try { await p.requestPermissions(); } catch {}
      return permission();
    }
    if (!('Notification' in window)) return 'unsupported';
    try { await Notification.requestPermission(); } catch {}
    return Notification.permission;
  }

  /* ---------------- showing a notification now ---------------- */
  async function show(title, body, { tag, taskId, urgent } = {}) {
    if ((await permission()) !== 'granted') return false;
    const sound = prefs().sound;
    if (isNative()) {
      const p = LN();
      try { await p.schedule({ notifications: [{ id: hash('now:' + (tag || title) + Date.now()), title, body, channelId: CHANNEL, extra: { taskId: taskId || null } }] }); return true; } catch { return false; }
    }
    const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/favicon-32.png', data: { taskId: taskId || null }, requireInteraction: !!urgent, silent: !sound };
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
      const n = new Notification(title, opts); n.onclick = () => { window.focus(); openTask(taskId); n.close(); }; return true;
    } catch { return false; }
  }
  function openTask(id) {
    if (location.hash.split('?')[0] !== '#tasks') location.hash = 'tasks';
    if (id) setTimeout(() => window.DHTasks && window.DHTasks.openTask(id), 350);
  }

  /* ---------------- what to say ---------------- */
  function digestFor(d, day, { includeOverdue = true } = {}) {
    const open = live(d), due = open.filter(t => t.due === day), over = includeOverdue ? open.filter(t => t.due && t.due < day) : [];
    if (!due.length && !over.length) return null;
    const names = due.slice(0, 3).map(t => t.title).join(' / ');
    const parts = [];
    if (due.length) parts.push(`${due.length} due today${names ? ': ' + names + (due.length > 3 ? ' ...' : '') : ''}`);
    if (over.length) parts.push(`${over.length} overdue`);
    return { title: 'DevHub: your day', body: parts.join(' - ') };
  }
  const remindBody = (t, d) => {
    const p = d.projects && d.projects.find(x => x.id === t.project && !x.deleted);
    return [t.due ? (t.due === dayKey(new Date()) ? 'Due today' : 'Due ' + t.due) : null, p ? p.name : null].filter(Boolean).join(' - ') || 'Reminder';
  };

  /* ---------------- Android: schedule with the OS ---------------- */
  let syncing = Promise.resolve();
  async function syncNative(d, p) {
    const ln = LN(); if (!ln || !d || (await permission()) !== 'granted') return;   // no data yet (app locked): leave the scheduled reminders alone
    try {
      await ln.createChannel({ id: CHANNEL, name: 'Task reminders', description: 'Reminders and your daily summary', importance: 5, visibility: 1, vibration: true, lights: true });
    } catch {}
    try { const pend = await ln.getPending(); if (pend.notifications && pend.notifications.length) await ln.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) }); } catch {}
    const list = [], now = Date.now(), exact = (await exactAlarm()) === 'granted';
    if (p.on && d) {
      for (const t of live(d)) {
        const at = t.remind && when(t.remind); if (!at || at.getTime() <= now) continue;
        list.push({ id: hash('r:' + t.id), title: t.title, body: remindBody(t, d), channelId: CHANNEL, schedule: { at, allowWhileIdle: exact }, extra: { taskId: t.id } });
      }
      if (p.digest) {
        const [h, m] = p.digestTime.split(':').map(Number);
        for (let i = 0; i < DIGEST_DAYS; i++) {
          const at = new Date(); at.setDate(at.getDate() + i); at.setHours(h, m, 0, 0);
          if (at.getTime() <= now) continue;
          const g = digestFor(d, dayKey(at)); if (!g) continue;
          list.push({ id: i + 1, title: g.title, body: g.body, channelId: CHANNEL, schedule: { at, allowWhileIdle: exact }, extra: { taskId: null } });
        }
      }
    }
    if (list.length) { try { await ln.schedule({ notifications: list.slice(0, 60) }); } catch (e) { console.warn('Could not schedule notifications', e); } }
  }

  /* ---------------- desktop / web: check while the page is open ---------------- */
  const fired = () => read(FIRED, {});
  async function tickWeb() {
    const p = prefs(), d = tasksDoc(); if (!p.on || !d || (await permission()) !== 'granted') return;
    const f = fired(), now = new Date(), nowMs = now.getTime(), keep = {};
    for (const [k, v] of Object.entries(f)) if (nowMs - v < 3 * 864e5) keep[k] = v;
    let changed = false;
    for (const t of live(d)) {
      const at = t.remind && when(t.remind); if (!at) continue;
      const k = `r:${t.id}:${t.remind}`;
      if (at.getTime() <= nowMs && nowMs - at.getTime() < 12 * 36e5 && !keep[k]) { keep[k] = nowMs; changed = true; await show(t.title, remindBody(t, d), { tag: k, taskId: t.id, urgent: true }); }
    }
    if (p.digest) {
      const [h, m] = p.digestTime.split(':').map(Number), at = new Date(); at.setHours(h, m, 0, 0);
      const k = 'digest:' + dayKey(now);
      if (nowMs >= at.getTime() && !keep[k]) {                  // once per day, even if DevHub was opened after the usual time
        keep[k] = nowMs; changed = true;
        const g = digestFor(d, dayKey(now)); if (g) await show(g.title, g.body, { tag: k });
      }
    }
    if (changed || Object.keys(keep).length !== Object.keys(f).length) write(FIRED, keep);
  }

  function sync() {
    const p = prefs(), d = tasksDoc();
    if (isNative()) syncing = syncing.then(() => syncNative(d, p)).catch(() => {});
    else tickWeb();
  }

  /* ---------------- Android: blocking permission gate ---------------- */
  let gate = null;
  async function checkGate() {
    if (!isNative() || !LN() || document.querySelector('dialog.bio-lock[open]')) return;   // after the fingerprint unlock, not on top of it
    const [perm, exact] = await Promise.all([permission(), exactAlarm()]);
    if (perm === 'granted' && exact === 'granted') { if (gate) { gate.close(); gate.remove(); gate = null; sync(); } return; }
    if (!gate) {
      gate = document.createElement('dialog'); gate.className = 'nt-gate'; gate.setAttribute('aria-label', 'Permissions required');
      gate.addEventListener('cancel', e => e.preventDefault());                // Back button and Esc cannot dismiss it
      document.body.appendChild(gate); gate.showModal();
    }
    const needNotif = perm !== 'granted', blocked = perm === 'denied';
    gate.innerHTML = `<form method="dialog" class="nt-gate-in" onsubmit="return false">
      <div class="nt-bell" aria-hidden="true">&#128276;</div>
      <h2>${needNotif ? 'Allow notifications' : 'Allow exact reminders'}</h2>
      <p>${needNotif
        ? 'DevHub needs notification permission to remind you about tasks when the app is closed. This is required to use the app.'
        : 'Android needs one more switch so reminders arrive at the exact minute: turn on <b>Alarms &amp; reminders</b> for DevHub. This is required to use the app.'}</p>
      ${needNotif && blocked ? '<p class="nt-steps">Android no longer shows the prompt. Open <b>Settings &rarr; Apps &rarr; DevHub &rarr; Notifications</b> and switch them on, then come back here. This screen closes by itself.</p>' : ''}
      <button type="button" class="primary" id="ntAllow">${needNotif ? (blocked ? 'I turned them on - check again' : 'Allow notifications') : 'Open alarm settings'}</button>
      <p class="hint" id="ntMsg" role="status"></p></form>`;
    $('#ntAllow', gate).onclick = async () => {
      if (needNotif) {
        const r = await request();
        if (r !== 'granted') { $('#ntMsg', gate).textContent = 'Still not allowed. DevHub cannot run without notifications.'; }
      } else { try { await LN().changeExactNotificationSetting(); } catch {} }
      setTimeout(checkGate, 400);
    };
  }

  /* ---------------- settings dialog ---------------- */
  async function openSettings() {
    let dlg = $('#ntDlg'); if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'ntDlg'; dlg.className = 'tk-dialog'; dlg.setAttribute('aria-label', 'Notifications'); document.body.appendChild(dlg); }
    const draw = async () => {
      const p = prefs(), perm = await permission(), native = isNative();
      const status = perm === 'granted' ? '<span class="nt-ok">Allowed on this device</span>'
        : perm === 'denied' ? '<span class="nt-bad">Blocked</span>' : perm === 'unsupported' ? '<span class="nt-bad">Not supported here</span>' : '<span class="nt-bad">Not asked yet</span>';
      dlg.innerHTML = `<form method="dialog" class="nt-form">
        <header class="tk-dlg-head"><h2>Notifications</h2><button class="ghost dr-x" value="close" aria-label="Close">&#10005;</button></header>
        <p class="nt-perm">${status}${perm === 'default' ? '<button type="button" class="primary" id="ntAsk">Allow notifications</button>' : ''}</p>
        ${perm === 'denied' ? `<p class="hint">${native ? 'Open Settings &rarr; Apps &rarr; DevHub &rarr; Notifications and switch them on.' : 'Your browser is blocking notifications for this site. Click the lock icon next to the address bar, set Notifications to Allow, then reload.'}</p>` : ''}
        ${perm === 'unsupported' ? '<p class="hint">This browser cannot show notifications. Try Chrome, Edge, Firefox or Safari 16.4+ (on iPhone, add DevHub to the Home Screen first), or use the Android app.</p>' : ''}
        <label class="nt-row"><input type="checkbox" id="ntOn" ${p.on ? 'checked' : ''}> <span><b>Task reminders</b><br><small>Notify at the time set under "Remind me" on a task.</small></span></label>
        <label class="nt-row"><input type="checkbox" id="ntDigest" ${p.digest ? 'checked' : ''}> <span><b>Daily summary</b><br><small>Tasks due today and overdue ones.</small></span><input type="time" id="ntTime" value="${esc(p.digestTime)}" aria-label="Daily summary time"></label>
        <label class="nt-row"><input type="checkbox" id="ntSound" ${p.sound ? 'checked' : ''}> <span><b>Sound</b></span></label>
        <p class="hint">${native ? 'Reminders are scheduled with Android, so they arrive even when DevHub is closed.' : 'Reminders fire while DevHub is open in a tab or installed as an app. Your browser cannot wake a closed page, so for reminders with the app closed use the Android app.'} Settings apply to this device only.</p>
        <footer class="nt-foot"><button type="button" id="ntTest" ${perm === 'granted' ? '' : 'disabled'}>Send a test notification</button><button class="primary" value="close">Done</button></footer></form>`;
      const ask = $('#ntAsk', dlg); if (ask) ask.onclick = async () => { await request(); draw(); sync(); };
      $('#ntOn', dlg).onchange = e => { setPrefs({ on: e.target.checked }); };
      $('#ntDigest', dlg).onchange = e => { setPrefs({ digest: e.target.checked }); };
      $('#ntTime', dlg).onchange = e => { if (e.target.value) setPrefs({ digestTime: e.target.value }); };
      $('#ntSound', dlg).onchange = e => { setPrefs({ sound: e.target.checked }); };
      $('#ntTest', dlg).onclick = async () => { const ok = await show('DevHub test', 'Notifications are working on this device.', { tag: 'test' }); if (!ok) $('#ntTest', dlg).textContent = 'Could not send - check permission'; };
    };
    await draw(); if (!dlg.open) dlg.showModal();
  }

  // A one-line prompt in the task view until the person has decided (desktop: the click is the user gesture browsers require)
  async function banner(host) {
    if (!host || isNative()) return;
    const perm = await permission(); if (perm !== 'default' || read('devhub:notify-dismissed', false)) return;
    const el = document.createElement('div'); el.className = 'nt-banner';
    el.innerHTML = '<span>&#128276; Get reminders for due tasks on this device?</span><span><button type="button" class="primary" data-a="allow">Turn on</button><button type="button" class="ghost" data-a="no">Not now</button></span>';
    el.onclick = async e => { const a = e.target.dataset && e.target.dataset.a; if (!a) return; if (a === 'allow') { await request(); sync(); } else write('devhub:notify-dismissed', true); el.remove(); };
    host.prepend(el);
  }

  /* ---------------- wiring ---------------- */
  function init() {
    if (isNative()) {
      const ln = LN();
      if (ln && ln.addListener) ln.addListener('localNotificationActionPerformed', e => { const id = e && e.notification && e.notification.extra && e.notification.extra.taskId; openTask(id); });
      const A = window.Capacitor.Plugins.App; if (A && A.addListener) A.addListener('appStateChange', s => { if (s.isActive) { checkGate(); sync(); } });
      checkGate();
    } else if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'notify-open') openTask(e.data.taskId); });
      setInterval(tickWeb, 20000);
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (isNative()) checkGate(); sync(); } });
    const dh = window.DH; if (dh && dh.data && dh.data.listeners) { let t; dh.data.listeners.add(() => { clearTimeout(t); t = setTimeout(sync, 800); }); }
    setTimeout(sync, 1500);
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('open'); if (q) setTimeout(() => openTask(q), 800); // opened from a notification while the app was closed
  }
  window.DHNotify = { permission, request, show, sync, openSettings, banner, prefs, setPrefs, isNative, checkGate };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else setTimeout(init, 0);
})();
