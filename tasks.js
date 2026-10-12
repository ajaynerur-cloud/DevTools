/* DevHub Tasks — per-user task tracker.
 * Stored in the signed-in user's tasks.json as:
 *   { tasks: [Task], projects: [{id,name,color,updatedAt}], settings: {dailyGoal} }
 * Task: { id, title, notes, due, priority 1-4, status todo|doing|review|blocked|hold|done, project, tags[], estimate (min),
 *         spent (sec), timerStart, subtasks[{id,title,done}], repeat, remind (local 'YYYY-MM-DDTHH:mm' or null), createdAt, updatedAt, completedAt, deleted? }
 */
(() => {
  'use strict';
  const { $, esc, toast, uid, dayKey, addDays, data, routes, view, syncLine, session } = window.DH;

  const PRIO = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
  const STATUS = { todo: 'To do', doing: 'In progress', review: 'In review', blocked: 'Blocked', hold: 'On hold', done: 'Done' };
  const ORDER = Object.keys(STATUS);                 // board / picker order
  const ACTIVE = ['doing', 'review'];                // being worked on right now: surfaced in Today and the sidebar count
  // Your own file (offline): use its words for status and priority, and show its extra fields
  const DEF_STATUS = { ...STATUS }, DEF_PRIO = { ...PRIO };
  const custom = () => window.DH.custom && window.DH.custom();
  function applyLabels() { const c = custom(); Object.assign(STATUS, DEF_STATUS, c ? c.labels.status : {}); Object.assign(PRIO, DEF_PRIO, c ? c.labels.priority : {}); }
  const REPEAT = { '': 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
  const COLORS = ['#3346D3', '#1F8A5B', '#C23B3B', '#B7791F', '#7C3AED', '#0E7490', '#DB2777', '#4B5563'];
  const VIEWS = [['week', 'Week'], ['board', 'Board'], ['all', 'All'], ['insights', 'Insights']];
  const ICONS = {
    week: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M16 3v4M8 3v4M4 11h16"/>',
    board: '<rect x="4" y="4" width="5" height="16" rx="1"/><rect x="11" y="4" width="5" height="10" rx="1"/><path d="M18 4v6"/>',
    all: '<path d="M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01"/>',
    insights: '<path d="M4 20h16M7 16V10M12 16V5M17 16v-3"/>' };
  const svg = (p, c = 'ic') => `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const BELL = '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1"/>';
  const now = () => new Date().toISOString();
  const today = () => dayKey(new Date());

  // Board view settings (per device): layout, card density, hide empty columns, fit columns to the screen
  const BV_KEY = 'devhub-board-view';
  const BV_LAYOUTS = [['auto', '<span class="bv-d">Auto</span><span class="bv-m">Tabs</span>'], ['row', '1 row'], ['2', '2 rows'], ['3', '3 rows'], ['list', 'List']];
  const BV_DENSITY = [['comfy', 'Comfortable'], ['compact', 'Compact'], ['titles', 'Titles only']];
  let bvOpen = false; // phone: the view options are folded behind a “View” button
  const bv = (() => { const d = { layout: 'auto', density: 'comfy', hideEmpty: false, fit: true, tab: 'todo' }; try { return { ...d, ...JSON.parse(localStorage.getItem(BV_KEY) || '{}') }; } catch { return d; } })();
  const saveBv = () => { try { localStorage.setItem(BV_KEY, JSON.stringify(bv)); } catch { } };
  let ui = { view: 'week', day: null, nodateOpen: false, q: '', project: '', prio: '', status: '', sort: 'due', showDone: false, doneOpen: false };

  /* ---------------- data ---------------- */
  function doc() {
    let d = data.get('tasks');
    if (!d || !Array.isArray(d.tasks)) d = migrate(d);
    d.projects ||= []; d.settings ||= { dailyGoal: 5 };
    for (const t of d.tasks) { // tolerate hand-edited or older records
      t.title ??= 'Untitled'; t.notes ??= ''; t.due ??= null; t.priority = [1, 2, 3, 4].includes(+t.priority) ? +t.priority : 3;
      if (!STATUS[t.status]) t.status = 'todo'; if (!Array.isArray(t.tags)) t.tags = []; if (!Array.isArray(t.subtasks)) t.subtasks = [];
      t.spent ??= 0; t.createdAt ??= t.updatedAt || now(); t.updatedAt ??= t.createdAt;
    }
    if (!snapReady) { buildSnap(d); snapReady = true; }
    return d;
  }

  /* ---------------- field versions ----------------
   * Every task carries  v  (a counter that goes up with each saved change),
   *                     fv (when each field last changed) and
   *                     hist (the last 20 deltas: which fields changed, from what, to what).
   * Sync merges task by task AND field by field, so an edit to the due date on your phone and an edit to the
   * title on your laptop both survive. Stamped here, in one place, by comparing each task with how it looked
   * before the edit, so every way of changing a task is covered. */
  const TRACK = ['title', 'notes', 'status', 'priority', 'due', 'remind', 'project', 'tags', 'estimate', 'repeat', 'subtasks', 'spent', 'deleted'];
  const LABEL = { title: 'Title', notes: 'Notes', status: 'Status', priority: 'Priority', due: 'Due', remind: 'Reminder', project: 'Project', tags: 'Tags', estimate: 'Estimate', repeat: 'Repeat', subtasks: 'Subtasks', deleted: 'Deleted', created: 'Created' };
  const snap = new Map(); let snapReady = false;
  const fval = (t, f) => f === 'deleted' ? !!t.deleted : (t[f] ?? null);
  function buildSnap(d) { snap.clear(); for (const t of d.tasks) snap.set(t.id, Object.fromEntries(TRACK.map(f => [f, JSON.stringify(fval(t, f))]))); }
  function shortVal(f, v, d) {
    if (v == null || v === '') return null;
    switch (f) {
      case 'status': return STATUS[v] || v;
      case 'priority': return PRIO[v] || v;
      case 'project': return (d.projects.find(p => p.id === v) || {}).name || null;
      case 'tags': return v.length ? v.map(x => '#' + x).join(' ') : null;
      case 'subtasks': return v.length ? `${v.filter(x => x.done).length}/${v.length} done` : null;
      case 'notes': return `${String(v).length} characters`;
      case 'remind': return String(v).replace('T', ' ');
      case 'estimate': return fmtEst(+v);
      case 'repeat': return REPEAT[v] || v;
      case 'deleted': return v ? 'yes' : 'no';
      default: return String(v).slice(0, 60);
    }
  }
  function stampDeltas(d) {
    const at = now();
    for (const t of d.tasks) {
      const prev = snap.get(t.id);
      if (!prev) {                                                    // a new task
        if (!t.v) { t.v = 1; t.fv = Object.fromEntries(TRACK.map(f => [f, at])); t.hist = [{ v: 1, at, d: { created: [null, shortVal('title', t.title, d)] } }]; }
        continue;
      }
      const changed = TRACK.filter(f => JSON.stringify(fval(t, f)) !== prev[f]);
      if (!changed.length) continue;
      t.v = (t.v || 0) + 1; t.fv = { ...(t.fv || {}) };
      const delta = {};
      for (const f of changed) { t.fv[f] = at; if (f !== 'spent') delta[f] = [shortVal(f, JSON.parse(prev[f]), d), shortVal(f, fval(t, f), d)]; }
      if (Object.keys(delta).length) t.hist = [...(t.hist || []), { v: t.v, at, d: delta }].slice(-20);
    }
  }
  function histHtml(t) {
    const h = (t.hist || []).slice(-10).reverse();
    if (!h.length) return '';
    return `<details class="dr-hist"><summary>History<span class="hint">version ${t.v || 1}</span></summary><ol>${h.map(e => `<li><span class="hv">v${e.v}</span><span class="ht">${esc(new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span><span class="hd">${Object.entries(e.d).map(([f, [a, b]]) => f === 'created' ? 'Created' : `${esc(LABEL[f] || f)}: <s>${esc(a ?? 'empty')}</s> → ${esc(b ?? 'empty')}`).join('<br>')}</span></li>`).join('')}</ol></details>`;
  }
  // Converts the old single-user format { "2026-09-26": [{text, done, priority}] }.
  function migrate(old) {
    const d = { tasks: [], projects: [], settings: { dailyGoal: 5 } };
    const legacy = old && typeof old === 'object' ? old : null;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy))
      for (const [day, list] of Object.entries(legacy)) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(list))
        list.forEach(t => d.tasks.push(blank({ title: t.text || 'Untitled', due: day, priority: { high: 2, med: 3, low: 4 }[t.priority] || 3, status: t.done ? 'done' : 'todo', completedAt: t.done ? (t.completed || t.created || now()) : null, createdAt: t.created || now() })));
    return d;
  }
  function save(d) {
    const cutoff = Date.now() - 30 * 864e5; // drop deletions older than 30 days once every device has had time to sync
    d.tasks = d.tasks.filter(t => !t.deleted || Date.parse(t.updatedAt) > cutoff);
    stampDeltas(d);
    data.set('tasks', d);
    buildSnap(d);
  }
  const blank = p => ({ id: uid(), title: '', notes: '', due: null, priority: 3, status: 'todo', project: null, tags: [], estimate: null, spent: 0, timerStart: null, subtasks: [], repeat: null, remind: null, createdAt: now(), updatedAt: now(), completedAt: null, ...p });
  const live = d => d.tasks.filter(t => !t.deleted);
  const find = (d, id) => d.tasks.find(t => t.id === id);
  const spentNow = t => (t.spent || 0) + (t.timerStart ? Math.max(0, (Date.now() - Date.parse(t.timerStart)) / 1000) : 0);
  const stopTimer = t => { if (t.timerStart) { t.spent = Math.round(spentNow(t)); t.timerStart = null; } };

  function patch(id, changes, { silent } = {}) {
    const d = doc(), t = find(d, id); if (!t) return;
    const wasDone = t.status === 'done';
    Object.assign(t, changes, { updatedAt: now() });
    if (t.status === 'done' && !wasDone) {
      t.completedAt = now(); stopTimer(t);
      if (t.repeat) {
        const next = blank({ ...t, id: uid(), status: 'todo', completedAt: null, spent: 0, timerStart: null, createdAt: now(), due: nextDue(t.due || today(), t.repeat), remind: shiftRemind(t.remind, t.due, nextDue(t.due || today(), t.repeat)), subtasks: t.subtasks.map(s => ({ ...s, id: uid(), done: false })) });
        d.tasks.push(next);
        if (!silent) { const l = dueLabel(next.due).text; toast(`Next “${t.title}” scheduled for ${/^(Today|Tomorrow)$/.test(l) ? l.toLowerCase() : l}`); }
      }
    }
    if (t.status !== 'done') t.completedAt = null;
    save(d); return t;
  }
  // A repeating task's reminder keeps the same time of day, moved by the same number of days as the due date
  function shiftRemind(remind, from, to) {
    if (!remind) return null;
    const days = Math.round((new Date(to + 'T12:00:00') - new Date((from || today()) + 'T12:00:00')) / 864e5), r = new Date(remind);
    if (isNaN(r)) return null; r.setDate(r.getDate() + days);
    const p = n => String(n).padStart(2, '0'); return `${r.getFullYear()}-${p(r.getMonth() + 1)}-${p(r.getDate())}T${p(r.getHours())}:${p(r.getMinutes())}`;
  }
  function nextDue(from, rep) {
    const d = new Date(from + 'T12:00:00');
    if (rep === 'daily') d.setDate(d.getDate() + 1);
    else if (rep === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (rep === 'weekly') d.setDate(d.getDate() + 7);
    else if (rep === 'monthly') { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    const n = dayKey(d); return n < today() ? nextDue(n, rep) : n;
  }
  function removeTask(id) {
    const d = doc(), t = find(d, id); if (!t) return;
    t.deleted = true; t.updatedAt = now(); stopTimer(t); save(d);
    toast(`Deleted “${t.title}”`, { label: 'Undo', fn: () => { const d2 = doc(), x = find(d2, id); if (x) { x.deleted = false; x.updatedAt = now(); save(d2); draw(); } } });
  }
  function toggleTimer(id) {
    const d = doc(), t = find(d, id); if (!t) return;
    if (t.timerStart) stopTimer(t);
    else { d.tasks.forEach(x => { if (x.timerStart) { stopTimer(x); x.updatedAt = now(); } }); t.timerStart = now(); if (t.status === 'todo') t.status = 'doing'; }
    t.updatedAt = now(); save(d);
  }

  /* ---------------- quick-add parsing ---------------- */
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function resolveDay(w) {
    w = w.toLowerCase(); const t = today();
    if (w === 'today' || w === 'tod') return t;
    if (w === 'tomorrow' || w === 'tmr') return addDays(t, 1);
    if (w === 'next week') { const d = new Date(t + 'T12:00:00'); return addDays(t, ((8 - d.getDay()) % 7) || 7); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
    const i = WD.indexOf(w.slice(0, 3)); if (i < 0) return null;
    const d = new Date(t + 'T12:00:00'); return addDays(t, (i - d.getDay() + 7) % 7 || 7);
  }
  function parseQuick(s) {
    const out = { tags: [], priority: null, due: null, estimate: null, repeat: null, projectName: null };
    let title = ' ' + s + ' ';
    const take = (re, fn) => { title = title.replace(re, (...m) => { fn(...m); return ' '; }); };
    take(/\s!(1|2|3|4|urgent|high|med(?:ium)?|low)(?=\s)/i, (_, p) => out.priority = { urgent: 1, high: 2, med: 3, medium: 3, low: 4 }[p.toLowerCase()] || +p);
    take(/\severy\s+(day|weekdays?|week|month)(?=\s)/i, (_, r) => out.repeat = r.startsWith('weekday') ? 'weekdays' : { day: 'daily', week: 'weekly', month: 'monthly' }[r.toLowerCase()]);
    take(/\s(today|tod|tomorrow|tmr|next week|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{4}-\d{2}-\d{2})(?=\s)/i, (_, w) => { if (!out.due) out.due = resolveDay(w); });
    take(/\s(\d+(?:\.\d+)?)\s?(m|min|mins|h|hr|hrs)(?=\s)/i, (_, n, u) => out.estimate = Math.round(u[0].toLowerCase() === 'h' ? n * 60 : +n));
    take(/\s#([\p{L}\d_-]+)/gu, (_, t) => out.tags.push(t.toLowerCase()));
    take(/\s@([\p{L}\d_-]+)/u, (_, p) => out.projectName = p);
    out.title = title.replace(/\s+/g, ' ').trim();
    return out;
  }
  function projectFor(d, name) {
    if (!name) return null;
    let p = d.projects.find(x => !x.deleted && x.name.toLowerCase() === name.toLowerCase());
    if (!p) { p = { id: uid(), name, color: COLORS[d.projects.length % COLORS.length], updatedAt: now() }; d.projects.push(p); }
    return p.id;
  }

  /* ---------------- formatting ---------------- */
  const fmtDur = sec => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; };
  const fmtClock = sec => { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
  const fmtEst = m => m >= 60 ? `${+(m / 60).toFixed(1)}h` : `${m}m`;
  function dueLabel(due) {
    if (!due) return { text: 'No date', cls: '' };
    const t = today(), diff = Math.round((Date.parse(due + 'T12:00:00') - Date.parse(t + 'T12:00:00')) / 864e5), d = new Date(due + 'T12:00:00');
    if (diff < 0) return { text: diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), cls: 'overdue' };
    if (diff === 0) return { text: 'Today', cls: 'today' };
    if (diff === 1) return { text: 'Tomorrow', cls: 'soon' };
    if (diff < 7) return { text: d.toLocaleDateString(undefined, { weekday: 'long' }), cls: 'soon' };
    return { text: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }), cls: '' };
  }
  const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
  const byPriority = (a, b) => a.priority - b.priority || (a.due || '9999').localeCompare(b.due || '9999') || a.createdAt.localeCompare(b.createdAt);

  /* ---------------- stats ---------------- */
  function stats(d) {
    const all = live(d), t = today();
    const doneOn = day => all.filter(x => x.completedAt && dayKey(new Date(x.completedAt)) === day);
    const doneToday = doneOn(t).length;
    let streak = 0; for (let k = doneToday ? t : addDays(t, -1); doneOn(k).length; k = addDays(k, -1)) streak++;
    const focusToday = all.reduce((s, x) => s + (x.timerStart ? spentNow(x) - (x.spent || 0) : 0), 0) + all.filter(x => x.completedAt && dayKey(new Date(x.completedAt)) === t).reduce((s, x) => s + (x.spent || 0), 0);
    const overdue = all.filter(x => x.status !== 'done' && x.due && x.due < t).length;
    return { doneToday, streak, overdue, focusToday, doneOn, goal: d.settings.dailyGoal || 5 };
  }

  /* ---------------- rendering ---------------- */
  function filtered(list) {
    const q = ui.q.trim().toLowerCase();
    return list.filter(t => (!ui.project || t.project === ui.project) && (!ui.prio || t.priority === +ui.prio) &&
      (!q || (t.title + ' ' + t.notes + ' ' + t.tags.join(' ')).toLowerCase().includes(q)));
  }
  // One quiet line under the title: due (when the list doesn't already imply it), status, reminder, project
  function metaHtml(t, d, { due = true } = {}) {
    const p = d.projects.find(x => x.id === t.project && !x.deleted), parts = [], isDone = t.status === 'done';
    if (due && (t.due || !isDone)) { const dl = dueLabel(t.due); parts.push(`<span class="mt ${isDone ? '' : dl.cls}">${esc(dl.text)}</span>`); }
    if (t.status !== 'todo' && !isDone) parts.push(`<span class="mt st st-${t.status}">${esc(STATUS[t.status])}</span>`);
    if (t.remind && !isDone) { const r = new Date(t.remind); if (!isNaN(r)) { const sameDay = !t.due || dayKey(r) === t.due; parts.push(`<span class="mt bell" title="Reminder">${svg(BELL)}${esc(r.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span>`); } }
    if (p) parts.push(`<span class="mt proj"><i style="background:${esc(p.color)}"></i>${esc(p.name)}</span>`);
    return parts.join('<span class="sep" aria-hidden="true">·</span>');
  }
  function rowHtml(t, d, o) {
    const running = !!t.timerStart;
    return `<li class="tk-row p${t.priority} ${t.status}" data-id="${t.id}">
      <button class="tk-check" role="checkbox" aria-checked="${t.status === 'done'}" aria-label="${t.status === 'done' ? 'Mark as not done' : 'Complete'}: ${esc(t.title)}"></button>
      <button class="tk-main" data-open aria-label="Open ${esc(t.title)}"><span class="tk-title">${esc(t.title)}</span>${(() => { const m = metaHtml(t, d, o); return m ? `<span class="tk-meta">${m}</span>` : ''; })()}</button>
      ${t.status === 'done' ? '' : `<button class="tk-timer ${running ? 'on' : ''}" data-timer aria-label="${running ? 'Stop' : 'Start'} timer" title="${running ? 'Stop' : 'Start'} timer">${running ? `<span data-clock="${t.id}">${fmtClock(spentNow(t))}</span>` : '▶'}</button>`}
    </li>`;
  }
  const listHtml = (items, d, empty, o) => items.length ? `<ul class="tk-list">${items.map(t => rowHtml(t, d, o)).join('')}</ul>` : `<p class="tk-empty">${empty}</p>`;
  const section = (title, count, body, extra = '') => `<section class="tk-sec"><header><h2>${title}</h2><span class="tk-count">${count}</span>${extra}</header>${body}</section>`;

  /* ---------------- week view ---------------- */
  const weekOf = day => { const off = (new Date(day + 'T12:00:00').getDay() + 6) % 7, mon = addDays(day, -off); return Array.from({ length: 7 }, (_, i) => addDays(mon, i)); };
  const dayTitle = k => k === today() ? 'Today' : k === addDays(today(), 1) ? 'Tomorrow' : k === addDays(today(), -1) ? 'Yesterday' : new Date(k + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  function dayItems(all, k) {
    const t = today();
    return all.filter(x => x.status === 'done'
      ? (x.completedAt ? dayKey(new Date(x.completedAt)) === k : x.due === k)
      : (x.due === k || (k === t && !x.due && ACTIVE.includes(x.status))));
  }
  function renderWeek(d) {
    const t = today(), day = ui.day || t, days = weekOf(day), all = filtered(live(d));
    const items = dayItems(all, day), open = items.filter(x => x.status !== 'done').sort((a, b) => ACTIVE.includes(b.status) - ACTIVE.includes(a.status) || (a.remind || '9').localeCompare(b.remind || '9') || byPriority(a, b));
    const done = items.filter(x => x.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    const overdue = day === t ? all.filter(x => x.status !== 'done' && x.due && x.due < t).sort(byPriority) : [];
    const nodate = day === t ? all.filter(x => x.status !== 'done' && !x.due && !ACTIVE.includes(x.status)).sort(byPriority) : [];
    const first = new Date(days[0] + 'T12:00:00'), last = new Date(days[6] + 'T12:00:00');
    const range = first.getMonth() === last.getMonth() ? first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : `${first.toLocaleDateString(undefined, { month: 'short' })} – ${last.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
    const strip = days.map(k => {
      const n = dayItems(all, k), left = n.filter(x => x.status !== 'done').length, dt = new Date(k + 'T12:00:00');
      const mark = left ? (k < t ? 'late' : 'has') : n.length ? 'clear' : '';
      return `<button type="button" class="wk-day ${k === day ? 'on' : ''} ${k === t ? 'today' : ''}" data-day="${k}" aria-pressed="${k === day}" aria-label="${esc(dt.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}, ${left} to do"><span class="wd">${esc(dt.toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${dt.getDate()}</b><i class="dot ${mark}"></i></button>`;
    }).join('');
    const pct = items.length ? Math.round(done.length / items.length * 100) : 0, planned = open.reduce((a, x) => a + (x.estimate || 0), 0);
    const emptyMsg = all.length ? (day === t ? 'Nothing left for today.' : 'Nothing planned for this day.') : 'Your day is clear. Add your first task above.';
    return `<div class="wk">
      <div class="wk-head"><h2>${esc(range)}</h2><div class="wk-nav"><button type="button" class="ghost" data-wk="-1" aria-label="Previous week">&#8249;</button><button type="button" class="ghost" data-wk="today">Today</button><button type="button" class="ghost" data-wk="1" aria-label="Next week">&#8250;</button></div></div>
      <div class="wk-strip" role="group" aria-label="Days of the week">${strip}</div>
      <div class="wk-sum"><div><h3>${esc(dayTitle(day))}</h3><p>${open.length ? `${open.length} to do` : items.length ? 'All done' : 'No tasks'}${done.length ? ` · ${done.length} done` : ''}${planned ? ` · ${fmtEst(planned)} planned` : ''}</p></div>${items.length ? `<span class="wk-pct">${pct}%</span>` : ''}</div>
      ${items.length ? `<div class="wk-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ''}
      ${overdue.length ? section('Overdue', overdue.length, listHtml(overdue, d, '', { due: true }), `<button class="ghost tk-link" data-act="reschedule">Move all to today</button>`) : ''}
      ${open.length ? listHtml(open, d, '', { due: false }) : (overdue.length ? '' : `<p class="tk-empty">${emptyMsg}</p>`)}
      ${done.length ? `<details class="tk-sec tk-done" ${ui.doneOpen ? 'open' : ''}><summary><h2>Completed</h2><span class="tk-count">${done.length}</span></summary>${listHtml(done, d, '', { due: false })}</details>` : ''}
      ${nodate.length ? `<details class="tk-sec tk-nodate" ${ui.nodateOpen ? 'open' : ''}><summary><h2>No date</h2><span class="tk-count">${nodate.length}</span></summary>${listHtml(nodate, d, '', { due: false })}</details>` : ''}
    </div>`;
  }
  function renderBoard(d) {
    const week = addDays(today(), -7), all = filtered(live(d));
    const cols = Object.fromEntries(ORDER.map(k => [k, k === 'done' ? all.filter(x => x.status === 'done' && x.completedAt && dayKey(new Date(x.completedAt)) >= week).sort((a, b) => b.completedAt.localeCompare(a.completedAt)) : all.filter(x => x.status === k).sort(byPriority)]));
    let shown = Object.entries(cols);
    if (bv.hideEmpty) shown = shown.filter(([s, items]) => items.length || s === 'todo');
    if (!shown.some(([s]) => s === bv.tab)) bv.tab = shown[0][0];
    const n = shown.length, per = bv.layout === 'row' ? n : bv.layout === '2' ? Math.ceil(n / 2) : bv.layout === '3' ? Math.ceil(n / 3) : n;
    const seg = (key, list) => `<div class="seg" role="radiogroup" aria-label="${key === 'layout' ? 'Board layout' : 'Card size'}">${list.map(([k, l]) => `<button type="button" role="radio" aria-checked="${bv[key] === k}" data-bv="${key}" data-v="${k}">${l}</button>`).join('')}</div>`;
    const bar = `<div class="tk-bv${bvOpen ? ' open' : ''}" aria-label="Board view options">
        <div class="tk-stabs" role="tablist" aria-label="Status">${shown.map(([s, items]) => `<button type="button" role="tab" data-btab="${s}" aria-selected="${s === bv.tab}" class="st-${s}">${STATUS[s]}<span class="n">${items.length}</span></button>`).join('')}</div>
        <button type="button" class="tk-bv-toggle ghost" data-bvt aria-expanded="${bvOpen}" aria-label="View options">${'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>'}</button>
        <div class="tk-bv-body"><span class="tk-bv-l">Layout</span>${seg('layout', BV_LAYOUTS)}
        <span class="tk-bv-l">Cards</span>${seg('density', BV_DENSITY)}
        <label class="inline"><input type="checkbox" data-bvc="hideEmpty" ${bv.hideEmpty ? 'checked' : ''}> Hide empty columns</label>
        ${bv.layout === 'list' ? '' : `<label class="inline" title="Long columns scroll on their own so the board fits the window"><input type="checkbox" data-bvc="fit" ${bv.fit ? 'checked' : ''}> Fit to screen</label>`}
      </div></div>`;
    return bar + `<div class="tk-board lay-${bv.layout} d-${bv.density}${bv.fit ? ' fit' : ''}" style="--n:${n};--c:${per}">${shown.map(([s, items]) => `<section class="tk-col${s === bv.tab ? ' on' : ''}" data-status="${s}"><header><h2>${STATUS[s]}</h2><span class="tk-count">${items.length}</span>${s === 'done' ? '<span class="hint">last 7 days</span>' : ''}</header>
      <div class="tk-cards" data-drop="${s}">${items.map(t => `<article class="tk-card p${t.priority} ${t.status}" draggable="true" data-id="${t.id}" tabindex="0"><div class="tk-card-top"><span class="prio-dot" title="${PRIO[t.priority]} priority"></span><span class="tk-title">${esc(t.title)}</span></div><div class="tk-meta">${metaHtml(t, d)}</div>
      <div class="tk-card-move">${ORDER.indexOf(s) > 0 ? `<button class="ghost" data-move="${ORDER[ORDER.indexOf(s) - 1]}" aria-label="Move back to ${STATUS[ORDER[ORDER.indexOf(s) - 1]]}">←<span class="mv-l">${STATUS[ORDER[ORDER.indexOf(s) - 1]]}</span></button>` : '<span></span>'}${ORDER.indexOf(s) < ORDER.length - 1 ? `<button class="ghost" data-move="${ORDER[ORDER.indexOf(s) + 1]}" aria-label="Move forward to ${STATUS[ORDER[ORDER.indexOf(s) + 1]]}"><span class="mv-l">${STATUS[ORDER[ORDER.indexOf(s) + 1]]}</span>→</button>` : ''}</div></article>`).join('') || `<p class="tk-empty"><span class="e-d">Drop tasks here</span><span class="e-m">Nothing in ${STATUS[s]}</span></p>`}</div></section>`).join('')}</div>`;
  }
  function renderAll(d) {
    let items = filtered(live(d)).filter(x => ui.status ? x.status === ui.status : ui.showDone || x.status !== 'done');
    const sorters = { due: (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || byPriority(a, b), priority: byPriority, created: (a, b) => b.createdAt.localeCompare(a.createdAt), title: (a, b) => a.title.localeCompare(b.title) };
    items.sort(sorters[ui.sort]);
    return `<div class="tk-allbar"><label class="inline">Status <select data-f="status"><option value="">Open</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${ui.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="inline">Sort <select data-f="sort">${[['due', 'Due date'], ['priority', 'Priority'], ['created', 'Newest'], ['title', 'Title']].map(([k, v]) => `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${ui.status ? '' : `<label class="inline"><input type="checkbox" data-f="showDone" ${ui.showDone ? 'checked' : ''}> Include completed</label>`}<span class="hint">${items.length} tasks</span></div>` +
      listHtml(items, d, 'No tasks match these filters.');
  }
  function renderInsights(d) {
    const s = stats(d), all = live(d), t = today();
    const days = Array.from({ length: 14 }, (_, i) => addDays(t, i - 13)), counts = days.map(k => s.doneOn(k).length), max = Math.max(1, ...counts);
    const week = days.slice(7).reduce((a, k) => a + s.doneOn(k).length, 0), lastWeek = days.slice(0, 7).reduce((a, k) => a + s.doneOn(k).length, 0);
    const focusWeek = all.filter(x => x.completedAt && dayKey(new Date(x.completedAt)) > addDays(t, -7)).reduce((a, x) => a + (x.spent || 0), 0);
    const open = all.filter(x => x.status !== 'done');
    const dueWeek = all.filter(x => x.due && x.due > addDays(t, -7) && x.due <= t);
    const onTime = dueWeek.filter(x => x.status === 'done' && dayKey(new Date(x.completedAt)) <= x.due).length;
    const W = 560, H = 150, TOP = 18, bw = W / 14;
    const chart = `<svg viewBox="0 ${-TOP} ${W} ${H + 24 + TOP}" class="tk-chart" role="img" aria-label="Tasks completed per day, last 14 days">${counts.map((c, i) => { const h = c / max * H; return `<g><rect x="${i * bw + 5}" y="${H - h}" width="${bw - 10}" height="${Math.max(h, 2)}" rx="4" class="${days[i] === t ? 'cur' : ''}"><title>${days[i]}: ${c} completed</title></rect>${c ? `<text x="${i * bw + bw / 2}" y="${H - h - 5}" text-anchor="middle" class="v">${c}</text>` : ''}<text x="${i * bw + bw / 2}" y="${H + 16}" text-anchor="middle" class="l">${new Date(days[i] + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'narrow' })}</text></g>`; }).join('')}</svg>`;
    const projRows = [...d.projects.filter(p => !p.deleted), { id: null, name: 'No project', color: 'var(--muted)' }].map(p => { const items = all.filter(x => (x.project || null) === p.id); return { p, open: items.filter(x => x.status !== 'done').length, done: items.filter(x => x.status === 'done').length }; }).filter(r => r.open + r.done);
    const pmax = Math.max(1, ...projRows.map(r => r.open + r.done));
    const delta = week - lastWeek;
    return `<div class="tk-kpi-grid">
        <div class="kpi"><span class="kpi-v">${week}</span><span class="kpi-l">completed in the last 7 days</span><span class="kpi-d ${delta >= 0 ? 'up' : 'down'}">${delta === 0 ? 'Same as the week before' : `${delta > 0 ? '+' : ''}${delta} vs the week before`}</span></div>
        <div class="kpi"><span class="kpi-v">${dueWeek.length ? Math.round(onTime / dueWeek.length * 100) + '%' : '—'}</span><span class="kpi-l">finished on time this week</span><span class="kpi-d">${onTime} of ${dueWeek.length} due</span></div>
        <div class="kpi"><span class="kpi-v">${fmtDur(focusWeek)}</span><span class="kpi-l">tracked focus time, 7 days</span></div>
        <div class="kpi"><span class="kpi-v">${s.streak}</span><span class="kpi-l">day streak</span><span class="kpi-d">Days in a row with a completed task</span></div>
      </div>
      <div class="tk-ins-grid">
        <section class="panel"><h2>Completed per day</h2>${chart}</section>
        <section class="panel"><h2>Open by priority</h2>${[1, 2, 3, 4].map(p => { const n = open.filter(x => x.priority === p).length; return `<div class="bar-row"><span class="prio-dot p${p}"></span><span>${PRIO[p]}</span><span class="bar"><i class="p${p}" style="width:${open.length ? n / open.length * 100 : 0}%"></i></span><b>${n}</b></div>`; }).join('')}</section>
        <section class="panel"><h2>Projects</h2>${projRows.length ? projRows.map(r => `<div class="bar-row"><i class="swatch-dot" style="background:${esc(r.p.color)}"></i><span>${esc(r.p.name)}</span><span class="bar"><i style="width:${r.done / pmax * 100}%;background:${esc(r.p.color)}"></i><i class="open" style="width:${r.open / pmax * 100}%"></i></span><b>${r.done}/${r.open + r.done}</b></div>`).join('') : '<p class="tk-empty">Add @project to a task to see project progress.</p>'}</section>
      </div>`;
  }

  function header(d) {
    const s = stats(d), first = (session.user?.name || '').split(' ')[0];
    return `<header class="tk-head">
      <div class="tk-hello"><h1>${greeting()}${first ? ', ' + esc(first) : ''}</h1><p class="tk-date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
      <p class="tk-sum"><button type="button" class="ghost" data-act="goal" title="Change daily goal">${s.doneToday} of ${s.goal} done today</button>${s.streak > 1 ? `<span>${s.streak}-day streak</span>` : ''}${s.overdue ? `<span class="warn">${s.overdue} overdue</span>` : ''}</p>
    </header>`;
  }

  function draw() {
    const d = doc(), el = $('#tkBody'); if (!el) return;
    const bodies = { week: renderWeek, board: renderBoard, all: renderAll, insights: renderInsights };
    el.innerHTML = bodies[ui.view](d);
    $('#tkHead').innerHTML = header(d);
    const t = today(), open = live(d).filter(x => x.status !== 'done');
    const counts = { week: open.filter(x => x.due && x.due <= t).length, board: open.filter(x => ACTIVE.includes(x.status)).length, all: open.length };
    document.querySelectorAll('.tk-tabs [data-view]').forEach(b => { const on = b.dataset.view === ui.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); const c = b.querySelector('.n'); if (c) c.textContent = counts[b.dataset.view] || ''; });
    $('#tkFilters').hidden = ui.view === 'insights';
    const qi = $('#tkInput'); if (qi && !qi.dataset.day) qi.placeholder = ui.view === 'week' ? `Add a task for ${(ui.day || t) === t ? 'today' : dayTitle(ui.day).split(',')[0].toLowerCase()}` : 'Add a task';
    const ps = $('#tkProject'); ps.innerHTML = `<option value="">All projects</option>${d.projects.filter(p => !p.deleted).map(p => `<option value="${p.id}" ${ui.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  }

  function renderTasks() {
    applyLabels();
    const v = view();
    v.innerHTML = `${syncLine()}<div class="tk">
      <div id="tkHead"></div>
      <form class="tk-quick" id="tkQuick" autocomplete="off">
        <div class="tk-quick-row"><span class="tk-plus" aria-hidden="true">+</span><input id="tkInput" aria-label="Add a task" placeholder="Add a task — e.g. Fix login bug #backend @web !high tomorrow 30m" maxlength="300"><button class="primary">Add task</button></div>
        <div class="tk-parse" id="tkParse" aria-live="polite"></div>
      </form>
      <div class="tk-toolbar">
        <div class="tk-tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" data-view="${k}">${svg(ICONS[k])}<span>${l}</span>${k !== 'insights' ? '<span class="n"></span>' : ''}</button>`).join('')}</div>
        <div class="tk-tools" id="tkFilters">
          <button type="button" class="tk-iconbtn tk-searchbtn" id="tkSearchBtn" aria-label="Search">${svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>')}</button>
          <input type="search" id="tkSearch" placeholder="Search tasks" aria-label="Search tasks" value="${esc(ui.q)}">
          <details class="tk-pop"><summary>Filter</summary><div class="tk-pop-body"><label>Project<select id="tkProject" aria-label="Filter by project"></select></label><label>Priority<select id="tkPrio" aria-label="Filter by priority"><option value="">Any priority</option>${[1, 2, 3, 4].map(p => `<option value="${p}" ${+ui.prio === p ? 'selected' : ''}>${PRIO[p]}</option>`).join('')}</select></label></div></details>
          <details class="tk-pop"><summary aria-label="More options">${svg('<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>')}</summary><div class="tk-pop-body menu"><button type="button" id="tkProjects">Projects</button><button type="button" id="tkNotify">Reminders</button>${session.user ? '<button type="button" id="tkBackup">Backup and import</button>' : ''}</div></details>
        </div>
      </div>
      <div id="tkBody" class="tk-body"></div>
    </div>
    <dialog class="tk-drawer" id="tkDrawer" aria-label="Task details"></dialog>
    <dialog class="tk-dialog" id="tkProjDlg" aria-label="Projects"></dialog>`;
    draw();
    wire();
  }

  /* ---------------- interactions ---------------- */
  function wire() {
    const input = $('#tkInput'), parse = $('#tkParse');
    const preview = () => {
      const p = parseQuick(input.value);
      const bits = [p.due && `<span class="chip due ${dueLabel(p.due).cls}">${esc(dueLabel(p.due).text)}</span>`, p.priority && `<span class="chip pr p${p.priority}">${PRIO[p.priority]}</span>`, p.projectName && `<span class="chip proj">@${esc(p.projectName)}</span>`, ...p.tags.map(t => `<span class="chip tag">#${esc(t)}</span>`), p.estimate && `<span class="chip">${fmtEst(p.estimate)}</span>`, p.repeat && `<span class="chip">↻ ${REPEAT[p.repeat]}</span>`].filter(Boolean);
      parse.innerHTML = input.value.trim() ? (bits.length ? bits.join('') : '<span class="hint">Tip: add #tag, @project, !high, tomorrow, 30m or “every weekday”</span>') : '';
    };
    input.oninput = preview;
    $('#tkQuick').onsubmit = e => {
      e.preventDefault(); const p = parseQuick(input.value);
      if (!p.title) { input.focus(); return; }
      const d = doc();
      const due = p.due ?? (ui.view === 'week' ? (ui.day || today()) : ui.view === 'board' ? today() : input.dataset.day || null);
      d.tasks.push(blank({ title: p.title, due, priority: p.priority || 3, tags: p.tags, estimate: p.estimate, repeat: p.repeat, project: projectFor(d, p.projectName) || ui.project || null }));
      save(d); input.value = ''; delete input.dataset.day; parse.innerHTML = ''; draw(); input.focus();
    };
    document.querySelectorAll('.tk-tabs [data-view]').forEach(b => b.onclick = () => { ui.view = b.dataset.view; draw(); });
    $('#tkSearch').oninput = e => { ui.q = e.target.value; draw(); };
    $('#tkSearchBtn').onclick = () => { const f = $('#tkFilters'); f.classList.toggle('searching'); if (f.classList.contains('searching')) $('#tkSearch').focus(); };
    if (ui.q) $('#tkFilters').classList.add('searching');
    $('#tkProject').onchange = e => { ui.project = e.target.value; draw(); };
    $('#tkPrio').onchange = e => { ui.prio = e.target.value; draw(); };
    $('#tkProjects').onclick = openProjects;
    $('#tkNotify').onclick = () => window.DHNotify && window.DHNotify.openSettings();
    if (window.DHNotify) window.DHNotify.banner($('.tk'));
    const bk = $('#tkBackup'); if (bk) bk.onclick = () => window.DH.backup();

    const body = $('#tkBody');
    body.addEventListener('click', e => {
      const bt = e.target.closest('[data-btab]'); if (bt) { showTab(bt.dataset.btab); return; }
      if (e.target.closest('[data-bvt]')) { bvOpen = !bvOpen; const w = body.querySelector('.tk-bv'); w.classList.toggle('open', bvOpen); e.target.closest('[data-bvt]').setAttribute('aria-expanded', bvOpen); return; }
      const bvb = e.target.closest('[data-bv]'); if (bvb) { bv[bvb.dataset.bv] = bvb.dataset.v; saveBv(); draw(); return; }
      const dayBtn = e.target.closest('[data-day]'); if (dayBtn) { ui.day = dayBtn.dataset.day === today() ? null : dayBtn.dataset.day; draw(); return; }
      const wk = e.target.closest('[data-wk]'); if (wk) { ui.day = wk.dataset.wk === 'today' ? null : addDays(ui.day || today(), 7 * +wk.dataset.wk); draw(); return; }
      const row = e.target.closest('[data-id]'), id = row?.dataset.id;
      if (e.target.closest('.tk-check')) { const wasDone = find(doc(), id).status === 'done'; patch(id, { status: wasDone ? 'todo' : 'done' }); if (!wasDone) celebrate(row); setTimeout(draw, wasDone ? 0 : 280); return; }
      if (e.target.closest('[data-timer]')) { toggleTimer(id); draw(); return; }
      if (e.target.closest('[data-move]')) { patch(id, { status: e.target.closest('[data-move]').dataset.move }); draw(); return; }
      if (e.target.closest('[data-open]') || (e.target.closest('.tk-card') && !e.target.closest('button'))) { openTask(id); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'reschedule') { const d = doc(), t = today(); let n = 0; live(d).forEach(x => { if (x.status !== 'done' && x.due && x.due < t) { x.due = t; x.updatedAt = now(); n++; } }); save(d); draw(); toast(`Moved ${n} task${n === 1 ? '' : 's'} to today`); }
      const addOn = e.target.closest('[data-add-on]');
      if (addOn) { input.dataset.day = addOn.dataset.addOn; input.placeholder = `Add a task for ${dueLabel(addOn.dataset.addOn).text}…`; input.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
    // phone tabs: tap a status, or swipe the cards left/right to go to the next/previous status
    function showTab(st, dir) {
      bv.tab = st; saveBv();
      body.querySelectorAll('[data-btab]').forEach(b => { const on = b.dataset.btab === st; b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); });
      body.querySelectorAll('.tk-col').forEach(c => { const on = c.dataset.status === st; c.classList.toggle('on', on); if (on && dir) { c.classList.remove('in-l', 'in-r'); void c.offsetWidth; c.classList.add(dir > 0 ? 'in-r' : 'in-l'); } });
    }
    let sx = null, sy = 0;
    body.addEventListener('touchstart', e => { sx = e.target.closest('.tk-board:not(.lay-list)') && matchMedia('(max-width: 800px)').matches ? e.touches[0].clientX : null; sy = e.touches[0].clientY; }, { passive: true });
    body.addEventListener('touchend', e => {
      if (sx === null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      const tabs = [...body.querySelectorAll('[data-btab]')].map(b => b.dataset.btab), i = tabs.indexOf(bv.tab), j = i + (dx < 0 ? 1 : -1);
      if (j >= 0 && j < tabs.length) showTab(tabs[j], dx < 0 ? 1 : -1);
    }, { passive: true });
    body.addEventListener('keydown', e => { const card = e.target.closest('.tk-card'); if (card && e.key === 'Enter') openTask(card.dataset.id); });
    body.addEventListener('change', e => { if (e.target.dataset.bvc) { bv[e.target.dataset.bvc] = e.target.checked; saveBv(); draw(); return; } const f = e.target.dataset.f; if (!f) return; ui[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; draw(); });
    body.addEventListener('toggle', e => { const c = e.target.classList; if (c?.contains('tk-done')) ui.doneOpen = e.target.open; else if (c?.contains('tk-nodate')) ui.nodateOpen = e.target.open; }, true);
    // Board drag and drop (mouse); touch uses the ← → buttons
    body.addEventListener('dragstart', e => { const c = e.target.closest('.tk-card'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); } });
    body.addEventListener('dragend', e => e.target.closest?.('.tk-card')?.classList.remove('dragging'));
    body.addEventListener('dragover', e => { const z = e.target.closest('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
    body.addEventListener('dragleave', e => e.target.closest?.('[data-drop]')?.classList.remove('over'));
    body.addEventListener('drop', e => { const z = e.target.closest('[data-drop]'); if (!z) return; e.preventDefault(); patch(e.dataTransfer.getData('text/plain'), { status: z.dataset.drop }); draw(); });
    $('#tkHead').addEventListener('click', e => { if (e.target.closest('[data-act="goal"]')) { const d = doc(); const v = prompt('How many tasks do you want to finish each day?', d.settings.dailyGoal || 5); if (v && +v > 0 && +v < 100) { d.settings.dailyGoal = Math.round(+v); save(d); draw(); } } });
  }
  function celebrate(row) { row?.classList.add('completing'); }

  // Close the filter and more menus when clicking elsewhere or choosing an item
  document.addEventListener('click', e => document.querySelectorAll('.tk-pop[open]').forEach(p => { if (!p.contains(e.target) || e.target.closest('.menu button')) p.open = false; }));

  // Keyboard shortcuts and live timers (installed once)
  document.addEventListener('keydown', e => {
    if (document.body.dataset.route !== 'tasks' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#tkInput')?.focus(); }
    else if (e.key === '/') { e.preventDefault(); $('#tkSearch')?.focus(); }
    else if (/^[1-4]$/.test(e.key)) { ui.view = VIEWS[+e.key - 1][0]; draw(); }
  });
  setInterval(() => {
    if (document.body.dataset.route !== 'tasks' || document.hidden) return;
    const d = data.get('tasks'); if (!d?.tasks) return;
    document.querySelectorAll('[data-clock]').forEach(el => { const t = d.tasks.find(x => x.id === el.dataset.clock); if (t) el.textContent = fmtClock(spentNow(t)); });
  }, 1000);

  /* ---------------- task drawer ---------------- */
  function openTask(id) {
    applyLabels();
    const dlg = $('#tkDrawer'), d = doc(), t = find(d, id); if (!t) return;
    const cx = custom() || { choices: {} }, xf = custom() ? cx.extraFields : Object.keys(t.fields || {}); // imported files keep their extra fields too
    const projects = d.projects.filter(p => !p.deleted);
    dlg.innerHTML = `<form method="dialog" class="dr">
      <div class="dr-grip" aria-hidden="true"></div>
      <header class="dr-top"><div class="seg" role="radiogroup" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<button type="button" role="radio" aria-checked="${t.status === k}" data-status="${k}">${v}</button>`).join('')}</div><button class="ghost dr-x" value="close" aria-label="Close">✕</button></header>
      <textarea class="dr-title" name="title" rows="1" aria-label="Task title" maxlength="300">${esc(t.title)}</textarea>
      <div class="dr-grid dr-main">
        <label>Due date<input type="date" name="due" value="${t.due || ''}"></label>
        <label>Remind me<input type="datetime-local" name="remind" value="${esc(t.remind || '')}"></label>
        <label>Priority<select name="priority">${[1, 2, 3, 4].map(p => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${PRIO[p]}</option>`).join('')}</select></label>
      </div>
      <details class="dr-more"><summary>More details<span class="hint">${[(projects.find(p => p.id === t.project) || {}).name, t.repeat && REPEAT[t.repeat].toLowerCase(), t.estimate && fmtEst(t.estimate), t.tags.length && t.tags.length + (t.tags.length === 1 ? ' tag' : ' tags')].filter(Boolean).map(esc).join(' · ')}</span></summary>
        <div class="dr-grid">
        <label>Project<select name="project"><option value="">No project</option>${projects.map(p => `<option value="${p.id}" ${t.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">New project…</option></select></label>
        <label>Repeat<select name="repeat">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}" ${(t.repeat || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Estimate (minutes)<input type="number" name="estimate" min="0" max="10000" step="5" value="${t.estimate ?? ''}" placeholder="e.g. 45"></label>
        <label>Tags<input name="tags" value="${esc(t.tags.join(', '))}" placeholder="bug, frontend" autocapitalize="off"></label>
        </div></details>
      <label class="dr-label">Notes<textarea name="notes" rows="4" placeholder="Details, links, acceptance criteria…">${esc(t.notes)}</textarea></label>
      ${xf.length ? `<section class="dr-xf"><h3>More fields <span class="hint">${custom() ? `from ${esc(window.DH.store.get('devhub:offline', {}).fileName || 'your file')}` : 'imported'}</span></h3><div class="dr-grid">${xf.map(k => { const v = t.fields?.[k] ?? '', ch = cx.choices[k];
        return `<label>${esc(k)}${ch ? `<select data-xf="${esc(k)}"><option value=""></option>${[...new Set([...ch, ...(v === '' ? [] : [String(v)])])].map(o => `<option ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}<option value="__other">Other…</option></select>` : `<input data-xf="${esc(k)}" value="${esc(v)}">`}</label>`; }).join('')}</div></section>` : ''}
      <section class="dr-sub"><h3>Subtasks <span class="hint" data-subcount></span></h3><ul data-subs></ul>
        <div class="dr-subadd"><input data-newsub placeholder="Add a subtask and press Enter" aria-label="New subtask"><button type="button" data-addsub>Add</button></div></section>
      <section class="dr-time"><div><h3>Time tracked</h3><p class="dr-spent" data-spent>${t.timerStart ? fmtClock(spentNow(t)) : fmtDur(spentNow(t))}${t.estimate ? ` of ${fmtEst(t.estimate)} estimated` : ''}</p></div>
        <button type="button" class="${t.timerStart ? 'danger' : 'primary'}" data-dtimer>${t.timerStart ? 'Stop timer' : 'Start timer'}</button></section>
      ${histHtml(t)}
      <footer class="dr-foot"><span class="hint">Created ${new Date(t.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${t.completedAt ? ` · Completed ${new Date(t.completedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</span>
        <button type="button" class="danger ghost" data-del>Delete task</button></footer>
    </form>`;
    const f = $('form', dlg);
    const drawSubs = () => { const x = find(doc(), id); $('[data-subs]', dlg).innerHTML = x.subtasks.map(s => `<li data-sid="${s.id}"><input type="checkbox" ${s.done ? 'checked' : ''} aria-label="Done"><input class="sub-t" value="${esc(s.title)}" aria-label="Subtask"><button type="button" class="ghost" data-rmsub aria-label="Remove subtask">✕</button></li>`).join(''); $('[data-subcount]', dlg).textContent = x.subtasks.length ? `${x.subtasks.filter(s => s.done).length}/${x.subtasks.length}` : ''; };
    drawSubs();
    const title = f.title; const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
    title.addEventListener('input', () => { grow(); patch(id, { title: title.value.replace(/\n/g, ' ').trim() || 'Untitled' }); });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    f.due.onchange = () => patch(id, { due: f.due.value || null });
    dlg.querySelectorAll('[data-xf]').forEach(el => el.onchange = () => { const x = find(doc(), id), k = el.dataset.xf, old = x.fields?.[k];
      if (el.value === '__other') { const nv = prompt(`New value for ${k}`); if (!nv?.trim()) { el.value = old ?? ''; return; } el.add(new Option(nv.trim(), nv.trim()), el.options.length - 1); el.value = nv.trim(); const c = custom(); if (c && c.choices[k] && !c.choices[k].includes(nv.trim())) c.choices[k].push(nv.trim()); }
      const v = typeof old === 'number' && el.value !== '' && !isNaN(+el.value) ? +el.value : el.value; patch(id, { fields: { ...(x.fields || {}), [k]: v } }); });
    f.remind.onchange = async () => {
      patch(id, { remind: f.remind.value || null });
      const N = window.DHNotify; if (!N || !f.remind.value) return;
      if ((await N.permission()) === 'default') await N.request();                                  // asking right after the person picked a time is the natural moment
      if ((await N.permission()) !== 'granted') toast('Reminder saved, but notifications are blocked on this device. Open Reminders to fix that.');
      N.sync();
    };
    f.priority.onchange = () => patch(id, { priority: +f.priority.value });
    f.repeat.onchange = () => patch(id, { repeat: f.repeat.value || null });
    f.estimate.onchange = () => patch(id, { estimate: f.estimate.value ? Math.max(0, Math.round(+f.estimate.value)) : null });
    f.tags.onchange = () => patch(id, { tags: [...new Set(f.tags.value.split(/[,\s]+/).map(s => s.replace(/^#/, '').toLowerCase()).filter(Boolean))] });
    let notesTimer; f.notes.oninput = () => { clearTimeout(notesTimer); notesTimer = setTimeout(() => patch(id, { notes: f.notes.value }), 400); };
    f.project.onchange = () => {
      if (f.project.value === '__new') {
        const name = prompt('Project name'); if (!name?.trim()) { f.project.value = find(doc(), id).project || ''; return; }
        const d2 = doc(), pid = projectFor(d2, name.trim()), x = find(d2, id); x.project = pid; x.updatedAt = now(); save(d2); openTask(id); return;
      }
      patch(id, { project: f.project.value || null });
    };
    dlg.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { patch(id, { status: b.dataset.status }); dlg.querySelectorAll('[data-status]').forEach(x => x.setAttribute('aria-checked', x === b)); });
    const addSub = () => { const i = $('[data-newsub]', dlg); if (!i.value.trim()) return; const x = find(doc(), id); patch(id, { subtasks: [...x.subtasks, { id: uid(), title: i.value.trim(), done: false }] }); i.value = ''; drawSubs(); i.focus(); };
    $('[data-addsub]', dlg).onclick = addSub;
    $('[data-newsub]', dlg).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } };
    $('[data-subs]', dlg).addEventListener('change', e => { const li = e.target.closest('[data-sid]'), x = find(doc(), id); patch(id, { subtasks: x.subtasks.map(s => s.id === li.dataset.sid ? { ...s, done: e.target.type === 'checkbox' ? e.target.checked : s.done, title: e.target.classList.contains('sub-t') ? e.target.value.trim() || s.title : s.title } : s) }); drawSubs(); });
    $('[data-subs]', dlg).addEventListener('click', e => { if (!e.target.closest('[data-rmsub]')) return; const sid = e.target.closest('[data-sid]').dataset.sid, x = find(doc(), id); patch(id, { subtasks: x.subtasks.filter(s => s.id !== sid) }); drawSubs(); });
    $('[data-dtimer]', dlg).onclick = () => { toggleTimer(id); openTask(id); };
    $('[data-del]', dlg).onclick = () => { dlg.close(); removeTask(id); draw(); };
    const tick = setInterval(() => { const x = find(doc(), id); const el = $('[data-spent]', dlg); if (!x || !el || !dlg.open) return clearInterval(tick); if (x.timerStart) el.textContent = `${fmtClock(spentNow(x))}${x.estimate ? ` of ${fmtEst(x.estimate)} estimated` : ''}`; }, 1000);
    dlg.onclose = () => { clearInterval(tick); draw(); };
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(grow);
  }

  /* ---------------- projects dialog ---------------- */
  function openProjects() {
    const dlg = $('#tkProjDlg'), d = doc(), all = live(d);
    const ps = d.projects.filter(p => !p.deleted);
    dlg.innerHTML = `<form method="dialog"><header class="dr-top"><h2>Projects</h2><button class="ghost dr-x" value="close" aria-label="Close">✕</button></header>
      <ul class="pj-list">${ps.map(p => `<li data-pid="${p.id}"><input type="color" value="${esc(p.color)}" aria-label="Colour for ${esc(p.name)}"><input class="pj-name" value="${esc(p.name)}" aria-label="Project name"><span class="hint">${all.filter(t => t.project === p.id && t.status !== 'done').length} open</span><button type="button" class="ghost danger" data-rmp aria-label="Delete project">✕</button></li>`).join('') || '<li class="tk-empty">No projects yet.</li>'}</ul>
      <div class="dr-subadd"><input data-newp placeholder="New project name" aria-label="New project name"><button type="button" class="primary" data-addp>Add project</button></div>
      <p class="hint">Tip: type @name in the quick-add box to create and assign a project in one go.</p></form>`;
    const upd = (pid, ch) => { const d2 = doc(), p = d2.projects.find(x => x.id === pid); Object.assign(p, ch, { updatedAt: now() }); save(d2); };
    dlg.querySelectorAll('[data-pid]').forEach(li => {
      const pid = li.dataset.pid;
      $('input[type=color]', li).onchange = e => upd(pid, { color: e.target.value });
      $('.pj-name', li).onchange = e => e.target.value.trim() && upd(pid, { name: e.target.value.trim() });
      $('[data-rmp]', li).onclick = () => { if (!confirm('Delete this project? Its tasks are kept without a project.')) return; const d2 = doc(); d2.projects.find(x => x.id === pid).deleted = true; d2.projects.find(x => x.id === pid).updatedAt = now(); d2.tasks.forEach(t => { if (t.project === pid) { t.project = null; t.updatedAt = now(); } }); if (ui.project === pid) ui.project = ''; save(d2); openProjects(); };
    });
    const add = () => { const i = $('[data-newp]', dlg); if (!i.value.trim()) return; const d2 = doc(); projectFor(d2, i.value.trim()); save(d2); openProjects(); $('[data-newp]', dlg).focus(); };
    $('[data-addp]', dlg).onclick = add; $('[data-newp]', dlg).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    dlg.onclose = draw;
    if (!dlg.open) dlg.showModal();
  }

  window.DHTasks = { openTask };
  window.DH.data.listeners.add(() => { snapReady = false; });
  routes.tasks = () => {
    // One-time import of tasks made before accounts existed
    const legacy = window.DH.store.get('devhub:tasks', null);
    if (legacy && Object.keys(legacy).length && !data.get('tasks')) {
      if (confirm('Tasks from before you had an account were found on this device. Add them to your account?')) data.set('tasks', migrate(legacy));
      window.DH.store.del('devhub:tasks');
    }
    renderTasks();
  };
})();
