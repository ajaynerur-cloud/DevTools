/* DevHub Tasks — per-user task tracker.
 * Stored in the signed-in user's tasks.json as:
 *   { tasks: [Task], projects: [{id,name,color,updatedAt}], settings: {dailyGoal} }
 * Task: { id, title, notes, due, priority 1-4, status todo|doing|done, project, tags[], estimate (min),
 *         spent (sec), timerStart, subtasks[{id,title,done}], repeat, createdAt, updatedAt, completedAt, deleted? }
 */
(() => {
  'use strict';
  const { $, esc, toast, uid, dayKey, addDays, data, routes, view, syncLine, session } = window.DH;

  const PRIO = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
  const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
  const REPEAT = { '': 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' };
  const COLORS = ['#3346D3', '#1F8A5B', '#C23B3B', '#B7791F', '#7C3AED', '#0E7490', '#DB2777', '#4B5563'];
  const VIEWS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['board', 'Board'], ['all', 'All tasks'], ['insights', 'Insights']];
  const now = () => new Date().toISOString();
  const today = () => dayKey(new Date());

  let ui = { view: 'today', q: '', project: '', prio: '', status: '', sort: 'due', showDone: false, doneOpen: false };

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
    return d;
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
    data.set('tasks', d);
  }
  const blank = p => ({ id: uid(), title: '', notes: '', due: null, priority: 3, status: 'todo', project: null, tags: [], estimate: null, spent: 0, timerStart: null, subtasks: [], repeat: null, createdAt: now(), updatedAt: now(), completedAt: null, ...p });
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
        const next = blank({ ...t, id: uid(), status: 'todo', completedAt: null, spent: 0, timerStart: null, createdAt: now(), due: nextDue(t.due || today(), t.repeat), subtasks: t.subtasks.map(s => ({ ...s, id: uid(), done: false })) });
        d.tasks.push(next);
        if (!silent) { const l = dueLabel(next.due).text; toast(`Next “${t.title}” scheduled for ${/^(Today|Tomorrow)$/.test(l) ? l.toLowerCase() : l}`); }
      }
    }
    if (t.status !== 'done') t.completedAt = null;
    save(d); return t;
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
  function chipHtml(t, d) {
    const p = d.projects.find(x => x.id === t.project && !x.deleted), due = dueLabel(t.due), subDone = t.subtasks.filter(s => s.done).length;
    return [
      t.due || t.status !== 'done' ? `<span class="chip due ${t.status === 'done' ? '' : due.cls}">${esc(due.text)}</span>` : '',
      p ? `<span class="chip proj"><i style="background:${esc(p.color)}"></i>${esc(p.name)}</span>` : '',
      ...t.tags.map(g => `<span class="chip tag">#${esc(g)}</span>`),
      t.subtasks.length ? `<span class="chip">${subDone}/${t.subtasks.length} subtasks</span>` : '',
      t.estimate || t.spent ? `<span class="chip">${t.spent ? fmtDur(t.spent) + (t.estimate ? ' / ' : '') : ''}${t.estimate ? fmtEst(t.estimate) : ''}</span>` : '',
      t.repeat ? `<span class="chip" title="${esc(REPEAT[t.repeat])}">↻ ${esc(REPEAT[t.repeat].replace('Every ', ''))}</span>` : '',
      t.notes ? `<span class="chip" title="Has notes">Notes</span>` : ''
    ].join('');
  }
  function rowHtml(t, d) {
    const running = !!t.timerStart;
    return `<li class="tk-row p${t.priority} ${t.status}" data-id="${t.id}">
      <button class="tk-check" role="checkbox" aria-checked="${t.status === 'done'}" aria-label="${t.status === 'done' ? 'Mark as not done' : 'Complete'}: ${esc(t.title)}"></button>
      <button class="tk-main" data-open aria-label="Open ${esc(t.title)}"><span class="tk-title">${esc(t.title)}</span><span class="tk-meta">${t.status === 'doing' ? '<span class="chip doing">In progress</span>' : ''}${chipHtml(t, d)}</span></button>
      ${t.status === 'done' ? '' : `<button class="tk-timer ${running ? 'on' : ''}" data-timer aria-label="${running ? 'Stop' : 'Start'} timer" title="${running ? 'Stop' : 'Start'} timer">${running ? `<span data-clock="${t.id}">${fmtClock(spentNow(t))}</span>` : '▶'}</button>`}
    </li>`;
  }
  const listHtml = (items, d, empty) => items.length ? `<ul class="tk-list">${items.map(t => rowHtml(t, d)).join('')}</ul>` : `<p class="tk-empty">${empty}</p>`;
  const section = (title, count, body, extra = '') => `<section class="tk-sec"><header><h2>${title}</h2><span class="tk-count">${count}</span>${extra}</header>${body}</section>`;

  function renderTodayView(d) {
    const t = today(), all = filtered(live(d));
    const overdue = all.filter(x => x.status !== 'done' && x.due && x.due < t).sort(byPriority);
    const todays = all.filter(x => x.status !== 'done' && (x.due === t || (x.status === 'doing' && (!x.due || x.due > t)))).sort((a, b) => (b.status === 'doing') - (a.status === 'doing') || byPriority(a, b));
    const done = all.filter(x => x.status === 'done' && x.completedAt && dayKey(new Date(x.completedAt)) === t).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const planned = todays.reduce((s, x) => s + (x.estimate || 0), 0);
    return (overdue.length ? section('Overdue', overdue.length, listHtml(overdue, d), `<button class="ghost tk-link" data-act="reschedule">Move all to today</button>`) : '') +
      section('Today', todays.length, listHtml(todays, d, all.length ? 'Nothing left for today. Add a task above, or pull something in from Upcoming.' : 'Your day is clear. Add your first task above — try “Review pull request #code !high 30m”.'), planned ? `<span class="hint tk-plan">${fmtEst(planned)} planned</span>` : '') +
      (done.length ? `<details class="tk-sec tk-done" ${ui.doneOpen ? 'open' : ''}><summary><h2>Completed today</h2><span class="tk-count">${done.length}</span></summary>${listHtml(done, d)}</details>` : '');
  }
  function renderUpcoming(d) {
    const t = today(), all = filtered(live(d)).filter(x => x.status !== 'done');
    let html = '';
    for (let i = 1; i <= 14; i++) {
      const k = addDays(t, i), items = all.filter(x => x.due === k).sort(byPriority);
      if (!items.length && i > 7) continue;
      const dt = new Date(k + 'T12:00:00');
      const title = i === 1 ? 'Tomorrow' : dt.toLocaleDateString(undefined, { weekday: 'long' });
      html += section(`${title} <span class="tk-sub">${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>`, items.length, listHtml(items, d, 'Nothing scheduled'), `<button class="ghost tk-link" data-add-on="${k}">+ Add</button>`);
    }
    const later = all.filter(x => x.due && x.due > addDays(t, 14)).sort((a, b) => a.due.localeCompare(b.due));
    const nodate = all.filter(x => !x.due).sort(byPriority);
    if (later.length) html += section('Later', later.length, listHtml(later, d));
    html += section('No date', nodate.length, listHtml(nodate, d, 'Every task has a date.'));
    return html;
  }
  function renderBoard(d) {
    const week = addDays(today(), -7), all = filtered(live(d));
    const cols = { todo: all.filter(x => x.status === 'todo').sort(byPriority), doing: all.filter(x => x.status === 'doing').sort(byPriority), done: all.filter(x => x.status === 'done' && x.completedAt && dayKey(new Date(x.completedAt)) >= week).sort((a, b) => b.completedAt.localeCompare(a.completedAt)) };
    return `<div class="tk-board">${Object.entries(cols).map(([s, items]) => `<section class="tk-col" data-status="${s}"><header><h2>${STATUS[s]}</h2><span class="tk-count">${items.length}</span>${s === 'done' ? '<span class="hint">last 7 days</span>' : ''}</header>
      <div class="tk-cards" data-drop="${s}">${items.map(t => `<article class="tk-card p${t.priority} ${t.status}" draggable="true" data-id="${t.id}" tabindex="0"><div class="tk-card-top"><span class="prio-dot" title="${PRIO[t.priority]} priority"></span><span class="tk-title">${esc(t.title)}</span></div><div class="tk-meta">${chipHtml(t, d)}</div>
      <div class="tk-card-move">${s !== 'todo' ? `<button class="ghost" data-move="${s === 'done' ? 'doing' : 'todo'}" aria-label="Move back">←</button>` : '<span></span>'}${s !== 'done' ? `<button class="ghost" data-move="${s === 'todo' ? 'doing' : 'done'}" aria-label="Move forward">→</button>` : ''}</div></article>`).join('') || '<p class="tk-empty">Drop tasks here</p>'}</div></section>`).join('')}</div>`;
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
    const s = stats(d), pct = Math.min(1, s.doneToday / s.goal), C = 2 * Math.PI * 26;
    const first = (session.user?.name || '').split(' ')[0];
    return `<header class="tk-head">
      <div class="tk-hello"><p class="tk-greet">${greeting()}${first ? ', ' + esc(first) : ''}</p><h1>${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h1></div>
      <div class="tk-stats">
        <button class="tk-ring" data-act="goal" title="Change daily goal"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" class="bg"/><circle cx="32" cy="32" r="26" class="fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg><span><b>${s.doneToday}</b>/${s.goal}</span></button>
        <div class="tk-stat"><b>${s.doneToday >= s.goal ? 'Goal met' : `${s.goal - s.doneToday} to go`}</b><span>daily goal</span></div>
        <div class="tk-stat"><b>${s.streak} ${s.streak === 1 ? 'day' : 'days'}</b><span>streak</span></div>
        <div class="tk-stat"><b data-focus>${fmtDur(s.focusToday)}</b><span>focus today</span></div>
        ${s.overdue ? `<div class="tk-stat warn"><b>${s.overdue}</b><span>overdue</span></div>` : ''}
      </div></header>`;
  }

  function draw() {
    const d = doc(), el = $('#tkBody'); if (!el) return;
    const bodies = { today: renderTodayView, upcoming: renderUpcoming, board: renderBoard, all: renderAll, insights: renderInsights };
    el.innerHTML = bodies[ui.view](d);
    $('#tkHead').innerHTML = header(d);
    const t = today(), open = live(d).filter(x => x.status !== 'done');
    const counts = { today: open.filter(x => x.due && x.due <= t).length, upcoming: open.filter(x => x.due > t).length, board: open.filter(x => x.status === 'doing').length, all: open.length };
    document.querySelectorAll('.tk-tabs [data-view]').forEach(b => { const on = b.dataset.view === ui.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); const c = b.querySelector('.n'); if (c) c.textContent = counts[b.dataset.view] || ''; });
    $('#tkFilters').hidden = ui.view === 'insights';
    const ps = $('#tkProject'); ps.innerHTML = `<option value="">All projects</option>${d.projects.filter(p => !p.deleted).map(p => `<option value="${p.id}" ${ui.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  }

  function renderTasks() {
    const v = view();
    v.innerHTML = `${syncLine()}<div class="tk">
      <div id="tkHead"></div>
      <form class="tk-quick" id="tkQuick" autocomplete="off">
        <div class="tk-quick-row"><span class="tk-plus" aria-hidden="true">+</span><input id="tkInput" aria-label="Add a task" placeholder="Add a task — e.g. Fix login bug #backend @web !high tomorrow 30m" maxlength="300"><button class="primary">Add task</button></div>
        <div class="tk-parse" id="tkParse" aria-live="polite"></div>
      </form>
      <div class="tk-toolbar">
        <div class="tk-tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" data-view="${k}">${l}${k !== 'insights' ? '<span class="n"></span>' : ''}</button>`).join('')}</div>
        <div class="tk-filters" id="tkFilters">
          <input type="search" id="tkSearch" placeholder="Search tasks" aria-label="Search tasks" value="${esc(ui.q)}">
          <select id="tkProject" aria-label="Filter by project"></select>
          <select id="tkPrio" aria-label="Filter by priority"><option value="">Any priority</option>${[1, 2, 3, 4].map(p => `<option value="${p}" ${+ui.prio === p ? 'selected' : ''}>${PRIO[p]}</option>`).join('')}</select>
          <button type="button" id="tkProjects">Projects</button>
        </div>
      </div>
      <div id="tkBody" class="tk-body"></div>
      <p class="tk-keys hint">Shortcuts: <kbd>N</kbd> new task · <kbd>/</kbd> search · <kbd>1</kbd>–<kbd>5</kbd> switch view</p>
    </div>
    <dialog class="tk-drawer" id="tkDrawer" aria-label="Task details"></dialog>
    <dialog class="tk-dialog" id="tkProjDlg" aria-label="Projects"></dialog>`;
    if (matchMedia('(max-width: 800px)').matches) $('#tkInput').placeholder = 'Add a task… try #tag !high tomorrow';
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
      const due = p.due ?? (ui.view === 'today' || ui.view === 'board' ? today() : input.dataset.day || null);
      d.tasks.push(blank({ title: p.title, due, priority: p.priority || 3, tags: p.tags, estimate: p.estimate, repeat: p.repeat, project: projectFor(d, p.projectName) || ui.project || null }));
      save(d); input.value = ''; delete input.dataset.day; parse.innerHTML = ''; draw(); input.focus();
    };
    document.querySelectorAll('.tk-tabs [data-view]').forEach(b => b.onclick = () => { ui.view = b.dataset.view; draw(); });
    $('#tkSearch').oninput = e => { ui.q = e.target.value; draw(); };
    $('#tkProject').onchange = e => { ui.project = e.target.value; draw(); };
    $('#tkPrio').onchange = e => { ui.prio = e.target.value; draw(); };
    $('#tkProjects').onclick = openProjects;

    const body = $('#tkBody');
    body.addEventListener('click', e => {
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
    body.addEventListener('keydown', e => { const card = e.target.closest('.tk-card'); if (card && e.key === 'Enter') openTask(card.dataset.id); });
    body.addEventListener('change', e => { const f = e.target.dataset.f; if (!f) return; ui[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; draw(); });
    body.addEventListener('toggle', e => { if (e.target.classList?.contains('tk-done')) ui.doneOpen = e.target.open; }, true);
    // Board drag and drop (mouse); touch uses the ← → buttons
    body.addEventListener('dragstart', e => { const c = e.target.closest('.tk-card'); if (c) { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); } });
    body.addEventListener('dragend', e => e.target.closest?.('.tk-card')?.classList.remove('dragging'));
    body.addEventListener('dragover', e => { const z = e.target.closest('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
    body.addEventListener('dragleave', e => e.target.closest?.('[data-drop]')?.classList.remove('over'));
    body.addEventListener('drop', e => { const z = e.target.closest('[data-drop]'); if (!z) return; e.preventDefault(); patch(e.dataTransfer.getData('text/plain'), { status: z.dataset.drop }); draw(); });
    $('#tkHead').addEventListener('click', e => { if (e.target.closest('[data-act="goal"]')) { const d = doc(); const v = prompt('How many tasks do you want to finish each day?', d.settings.dailyGoal || 5); if (v && +v > 0 && +v < 100) { d.settings.dailyGoal = Math.round(+v); save(d); draw(); } } });
  }
  function celebrate(row) { row?.classList.add('completing'); }

  // Keyboard shortcuts and live timers (installed once)
  document.addEventListener('keydown', e => {
    if (document.body.dataset.route !== 'tasks' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#tkInput')?.focus(); }
    else if (e.key === '/') { e.preventDefault(); $('#tkSearch')?.focus(); }
    else if (/^[1-5]$/.test(e.key)) { ui.view = VIEWS[+e.key - 1][0]; draw(); }
  });
  setInterval(() => {
    if (document.body.dataset.route !== 'tasks' || document.hidden) return;
    const d = data.get('tasks'); if (!d?.tasks) return;
    document.querySelectorAll('[data-clock]').forEach(el => { const t = d.tasks.find(x => x.id === el.dataset.clock); if (t) el.textContent = fmtClock(spentNow(t)); });
  }, 1000);

  /* ---------------- task drawer ---------------- */
  function openTask(id) {
    const dlg = $('#tkDrawer'), d = doc(), t = find(d, id); if (!t) return;
    const projects = d.projects.filter(p => !p.deleted);
    dlg.innerHTML = `<form method="dialog" class="dr">
      <header class="dr-top"><div class="seg" role="radiogroup" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<button type="button" role="radio" aria-checked="${t.status === k}" data-status="${k}">${v}</button>`).join('')}</div><button class="ghost dr-x" value="close" aria-label="Close">✕</button></header>
      <textarea class="dr-title" name="title" rows="1" aria-label="Task title" maxlength="300">${esc(t.title)}</textarea>
      <div class="dr-grid">
        <label>Due date<input type="date" name="due" value="${t.due || ''}"></label>
        <label>Priority<select name="priority">${[1, 2, 3, 4].map(p => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${PRIO[p]}</option>`).join('')}</select></label>
        <label>Project<select name="project"><option value="">No project</option>${projects.map(p => `<option value="${p.id}" ${t.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">New project…</option></select></label>
        <label>Repeat<select name="repeat">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}" ${(t.repeat || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Estimate (minutes)<input type="number" name="estimate" min="0" max="10000" step="5" value="${t.estimate ?? ''}" placeholder="e.g. 45"></label>
        <label>Tags<input name="tags" value="${esc(t.tags.join(', '))}" placeholder="bug, frontend" autocapitalize="off"></label>
      </div>
      <label class="dr-label">Notes<textarea name="notes" rows="4" placeholder="Details, links, acceptance criteria…">${esc(t.notes)}</textarea></label>
      <section class="dr-sub"><h3>Subtasks <span class="hint" data-subcount></span></h3><ul data-subs></ul>
        <div class="dr-subadd"><input data-newsub placeholder="Add a subtask and press Enter" aria-label="New subtask"><button type="button" data-addsub>Add</button></div></section>
      <section class="dr-time"><div><h3>Time tracked</h3><p class="dr-spent" data-spent>${t.timerStart ? fmtClock(spentNow(t)) : fmtDur(spentNow(t))}${t.estimate ? ` of ${fmtEst(t.estimate)} estimated` : ''}</p></div>
        <button type="button" class="${t.timerStart ? 'danger' : 'primary'}" data-dtimer>${t.timerStart ? 'Stop timer' : 'Start timer'}</button></section>
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
