/* Toolbox+ Home — the start page: what needs attention today, quick access to everything, and every tool by group.
 * Reads only what is already on this device (tasks cache, Links, Insurance); it never contacts the server.
 */
(() => {
  'use strict';
  const DH = window.DH; if (!DH) return;
  const { $, esc, view, routes, store, data, session } = DH;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ICON = {   // small line icons, 24×24, currentColor
    tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    links: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    insurance: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    stores: '<path d="M4 7h16l-1 13H5z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    sync: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
    Formatters: '<path d="M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 1 3 3 3"/><path d="M16 4c2 0 3 1 3 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2-1 3-3 3"/>',
    Converters: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
    'SAP tools': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h4M7 14h7"/>',
    'Encode & decode': '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    Text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
    Generators: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
    Utilities: '<path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5L15 12l-3-3z"/>'
  };
  const ico = k => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.Utilities}</svg>`;
  // phones start with every tool group collapsed (one tap opens a group); computers start expanded
  const collapsed = () => store.get('toolbox:home-collapsed', null) || (window.matchMedia && matchMedia('(max-width: 800px)').matches ? Object.fromEntries(DH.groups.map(g => [g, 1])) : {});
  const setCollapsed = m => store.set('toolbox:home-collapsed', m);
  const daysBetween = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);

  async function render() {
    if (document.body.dataset.route !== 'home') return;
    const u = session.user, now = new Date(), today = ymd(now);
    const hello = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';
    // ---- what's on this device ----
    const td = data.get && data.get('tasks'), tasks = td && Array.isArray(td.tasks) ? td.tasks.filter(t => !t.deleted && t.status !== 'done') : null;
    const dueToday = tasks ? tasks.filter(t => t.due === today).length : 0, overdue = tasks ? tasks.filter(t => t.due && t.due < today).length : 0;
    const links = DH.wl ? DH.wl.all().filter(l => !l.deleted) : [], pinned = links.filter(l => l.pinned).slice(0, 8);
    let pols = []; try { pols = window.DHInsurance ? await window.DHInsurance.policies() : []; } catch {}
    const upcoming = pols.filter(p => p.nextDate).map(p => ({ p, left: daysBetween(now, new Date(p.nextDate + 'T00:00')) })).sort((a, b) => a.left - b.left);
    const soon = upcoming.filter(x => x.left <= (+x.p.daysBefore || 30)).length;
    const next = upcoming[0];
    const tools = DH.tools, groups = DH.groups.map(g => [g, tools.filter(t => t.group === g)]).filter(([, l]) => l.length);
    const recent = store.get('toolbox:recent-tools', []).map(id => tools.find(t => t.id === id)).filter(Boolean).slice(0, 4);
    const col = collapsed();
    if (document.body.dataset.route !== 'home') return;

    view().innerHTML = `<section class="hm-hero">
        <div><p class="hm-date">${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1>${hello}${u ? ', ' + esc((u.name || u.username).split(' ')[0]) : ''}</h1>
          <p class="lede">Tools, tasks, links and policies — in one place, online or offline.</p></div>
        <label class="hm-search"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="hmQ" type="search" placeholder="Search tools, links and policies…" aria-label="Search everything" autocomplete="off"></label>
        <div class="hm-results" id="hmRes" hidden></div>
      </section>

      <section class="hm-cards" aria-label="Overview">
        <a class="hm-card" href="#tasks"><span class="hm-ic c1">${ico('tasks')}</span><span class="hm-k">Tasks</span>
          <span class="hm-v">${tasks ? (dueToday || overdue ? `${dueToday} due today` : 'All clear today') : 'Plan your day'}</span>
          <span class="hm-s ${overdue ? 'warn' : ''}">${tasks ? (overdue ? `${overdue} overdue` : `${tasks.length} open`) : 'Sign in or use an offline database'}</span></a>
        <a class="hm-card" href="#insurance"><span class="hm-ic c2">${ico('insurance')}</span><span class="hm-k">Insurance</span>
          <span class="hm-v">${next ? esc(next.p.name) : pols.length ? 'No renewals set' : 'Add your policies'}</span>
          <span class="hm-s ${next && next.left <= (+next.p.daysBefore || 30) ? 'warn' : ''}">${next ? (next.left < 0 ? `Overdue by ${-next.left} days` : next.left === 0 ? 'Renews today' : `Renews in ${next.left} days`) + (soon > 1 ? ` · ${soon} due soon` : '') : 'Reminders before every renewal'}</span></a>
        <a class="hm-card" href="#worklinks"><span class="hm-ic c3">${ico('links')}</span><span class="hm-k">Links</span>
          <span class="hm-v">${links.length ? `${links.length} saved` : 'Your daily links'}</span>
          <span class="hm-s">${pinned.length ? `${pinned.length} pinned` : 'Saved on this device · sync optional'}</span></a>
        <a class="hm-card" href="${u ? '#account' : '#start'}"><span class="hm-ic c4">${ico('sync')}</span><span class="hm-k">Sync</span>
          <span class="hm-v">${u ? 'Signed in' : DH.offline && DH.offline.meta ? 'Offline database' : 'This device only'}</span>
          <span class="hm-s">${u ? esc(u.username) : 'Sign in when you want to sync'}</span></a>
      </section>

      ${pinned.length ? `<section class="hm-sec"><header><h2>Pinned links</h2><a href="#worklinks" class="hm-more">All links →</a></header>
        <div class="hm-chips">${pinned.map(l => `<a class="hm-chip" href="${esc(/^https?:\/\//i.test(l.url) ? l.url : '#')}" target="_blank" rel="noopener" title="${esc(l.url)}"><span class="hm-chip-i">${esc((l.name || '?')[0].toUpperCase())}</span>${esc(l.name)}</a>`).join('')}</div></section>` : ''}

      ${recent.length ? `<section class="hm-sec"><header><h2>Recently used</h2></header>
        <div class="hm-tiles">${recent.map(t => `<a class="hm-tile" href="#tools/${t.id}"><span class="hm-tile-ic">${ico(t.group)}</span><span class="hm-tile-n">${esc(t.name)}</span><span class="hm-tile-g">${esc(t.group)}</span></a>`).join('')}</div></section>` : ''}

      <section class="hm-sec"><header><h2>All tools <span class="hint">${tools.length}</span></h2>
          <span class="hm-acts">${DH.density ? DH.density.bar('home-tools', 2) : ''}<button type="button" class="ghost" id="hmExpand">Expand all</button><button type="button" class="ghost" id="hmCollapse">Collapse all</button></span></header>
        <div class="hm-groups dens-${DH.density ? DH.density.get('home-tools', 2) : 2}">${groups.map(([g, l]) => `<div class="hm-group${col[g] ? ' collapsed' : ''}" data-g="${esc(g)}">
          <button type="button" class="hm-gh" aria-expanded="${!col[g]}"><span class="hm-gi">${ico(g)}</span><span class="hm-gn">${esc(g)}</span><span class="hm-gc">${l.length}</span>
            <svg class="hm-chev" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M5 7.5 10 12.5l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <ul class="hm-tl">${l.map(t => `<li><a href="#tools/${t.id}"><b>${esc(t.name)}</b><span class="hm-d1">${esc(t.desc.split(/(?<=\.)\s/)[0])}</span><span class="hm-d3">${esc(t.desc)}</span></a></li>`).join('')}</ul></div>`).join('')}</div></section>

      <section class="hm-sec hm-more-sec"><header><h2>More</h2></header>
        <div class="hm-tiles">
          <a class="hm-tile" href="#links"><span class="hm-tile-ic">${ico('stores')}</span><span class="hm-tile-n">Tool stores</span><span class="hm-tile-g">Registries &amp; marketplaces</span></a>
          <a class="hm-tile" href="#tasks"><span class="hm-tile-ic">${ico('tasks')}</span><span class="hm-tile-n">Board &amp; insights</span><span class="hm-tile-g">Tasks</span></a>
          <a class="hm-tile" href="${u ? '#account' : '#start'}"><span class="hm-tile-ic">${ico('sync')}</span><span class="hm-tile-n">${u ? 'Account &amp; backups' : 'Sign in or use offline'}</span><span class="hm-tile-g">Data</span></a>
        </div></section>`;

    // ---- collapse / expand ----
    view().querySelectorAll('.hm-gh').forEach(b => b.onclick = () => {
      const g = b.closest('.hm-group'), c = !g.classList.contains('collapsed'), m = collapsed();
      g.classList.toggle('collapsed', c); b.setAttribute('aria-expanded', String(!c)); if (c) m[g.dataset.g] = 1; else delete m[g.dataset.g]; setCollapsed(m);
    });
    const all = c => { const m = {}; view().querySelectorAll('.hm-group').forEach(g => { g.classList.toggle('collapsed', c); $('.hm-gh', g).setAttribute('aria-expanded', String(!c)); if (c) m[g.dataset.g] = 1; }); setCollapsed(m); };
    if (DH.density) DH.density.wire('home-tools', render);
    $('#hmExpand').onclick = () => all(false); $('#hmCollapse').onclick = () => all(true);

    // ---- search everything on this device ----
    const res = $('#hmRes');
    $('#hmQ').oninput = e => {
      const q = e.target.value.trim().toLowerCase(); if (!q) { res.hidden = true; res.innerHTML = ''; return; }
      const hit = s => String(s || '').toLowerCase().includes(q);
      const T = tools.filter(t => hit(t.name) || hit(t.group) || hit(t.desc)).slice(0, 6).map(t => `<a href="#tools/${t.id}"><span class="hm-rk">Tool</span><b>${esc(t.name)}</b><span>${esc(t.group)}</span></a>`);
      const L = links.filter(l => hit(l.name) || hit(l.url) || hit(l.category)).slice(0, 5).map(l => `<a href="${esc(/^https?:\/\//i.test(l.url) ? l.url : '#')}" target="_blank" rel="noopener"><span class="hm-rk">Link</span><b>${esc(l.name)}</b><span>${esc(String(l.url).replace(/^https?:\/\//, ''))}</span></a>`);
      const P = pols.filter(p => hit(p.name) || hit(p.insurer) || hit(p.number)).slice(0, 4).map(p => `<a href="#insurance"><span class="hm-rk">Policy</span><b>${esc(p.name)}</b><span>${esc(p.insurer || '')}</span></a>`);
      const rows = [...T, ...L, ...P];
      res.innerHTML = rows.join('') || '<p class="hint">Nothing found.</p>'; res.hidden = false;
    };
    $('#hmQ').onkeydown = e => { if (e.key === 'Enter') { const a = $('#hmRes a'); if (a) a.click(); } if (e.key === 'Escape') { e.target.value = ''; res.hidden = true; } };
  }

  routes.home = () => { view().innerHTML = ''; render(); };
  window.DHHome = { render };
})();
