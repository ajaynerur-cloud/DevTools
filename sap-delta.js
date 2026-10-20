// Toolbox+ › SAP tools › SAP Scope Delta (UI). Compares two ATC / CVA result sheets per system and shows what is common (by priority),
// what B adds on top of A, and the additional effort as a percentage. Runs entirely in the browser; the Excel export uses the bundled xlsx library.
(function () {
  'use strict';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const LS = 'dh-sapdelta-opts';
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const fmt = n => Number(n).toLocaleString('en-US');
  const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '–';
  const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  let libP = null;
  const loadLib = () => libP ||= new Promise((ok, no) => {
    if (window.XLSX && window.XLSX.read) return ok(window.XLSX);
    const s = document.createElement('script'); s.src = 'vendor/xlsx-style.min.js';
    s.onload = () => ok(window.XLSX); s.onerror = () => { libP = null; no(new Error('Could not load the Excel library.')); };
    document.head.appendChild(s);
  });

  const COLS = [
    ['name', 'Object name', [/^object\s*name$/i, /obj.*name/i, /^object$/i, /^name$/i]],
    ['type', 'Object type', [/^object\s*type$/i, /obj.*type/i, /^type$/i]],
    ['prio', 'Priority', [/^priority$/i, /^highest priority$/i, /prio/i]],
    ['msg', 'Check message', [/^check message$/i, /message/i]],
    ['title', 'Check title', [/^check title$/i, /title/i]],
    ['pkg', 'Package', [/^package$/i, /devclass/i, /package/i]]
  ];
  const detectCols = headers => {
    const out = {};
    for (const [k, , res] of COLS) { let i = -1; for (const re of res) { i = headers.findIndex(h => re.test(String(h).trim())); if (i >= 0) break; } out[k] = i; }
    return out;
  };

  let uid = 1;
  const newSlot = () => ({ fileName: '', size: 0, buf: null, sheets: [], sheet: '', headers: [], cols: {}, rows: null, status: '', err: false });
  const newPair = () => ({ id: uid++, name: '', aLabel: 'RISE', bLabel: 'CVA', A: newSlot(), B: newSlot() });
  // Settings and the loaded comparisons survive switching tools during the session.
  const S = window.__sapDeltaState ||= Object.assign({ prios: ['P1', 'P2'], exclude: 'syntax error', fp: 30, keyMode: 'nt' }, ls.get(LS, {}), { pairs: [], active: null, ran: false, results: new Map(), q: '' });
  if (!S.pairs.length) { const p = newPair(); S.pairs.push(p); S.active = p.id; }
  const saveOpts = () => ls.set(LS, { prios: S.prios, exclude: S.exclude, fp: S.fp, keyMode: S.keyMode });

  const normPrio = v => { const s = String(v ?? '').trim(); if (!s) return '—'; const m = s.match(/\d+/); return m ? 'P' + parseInt(m[0], 10) : s; };
  const rank = p => { const m = /^P(\d+)$/.exec(p); return m ? +m[1] : 99; };
  const prioSort = (a, b) => rank(a) - rank(b) || a.localeCompare(b);

  function validate(slot) {
    if (!slot.rows) return;
    const miss = ['name', 'prio'].filter(k => slot.cols[k] < 0).map(k => COLS.find(c => c[0] === k)[1]);
    slot.err = miss.length > 0;
    slot.status = miss.length ? 'Pick the column for: ' + miss.join(', ') : fmt(slot.rows.length) + ' findings in sheet';
  }

  function aggregate(slot) {
    const c = slot.cols, kws = S.exclude.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), inScope = new Set(S.prios);
    const objs = new Map(), anyKeys = new Map(); let excluded = 0;
    for (const r of slot.rows) {
      const nm = String(r[c.name] ?? '').trim(); if (!nm) continue;
      if (kws.length) { const t = ((c.msg >= 0 ? r[c.msg] : '') + ' | ' + (c.title >= 0 ? r[c.title] : '')).toLowerCase(); if (kws.some(k => t.includes(k))) { excluded++; continue; } }
      const ty = c.type >= 0 ? String(r[c.type] ?? '').trim().toUpperCase() : '';
      const key = nm.toUpperCase() + (S.keyMode === 'nt' ? '|' + ty : '');
      const p = normPrio(r[c.prio]);
      const pa = anyKeys.get(key); if (!pa || rank(p) < rank(pa)) anyKeys.set(key, p);
      if (!inScope.has(p)) continue;
      let o = objs.get(key);
      if (!o) { o = { key, name: nm, type: ty, prio: p, n: 0, pkg: c.pkg >= 0 ? String(r[c.pkg] ?? '') : '' }; objs.set(key, o); }
      o.n++; if (rank(p) < rank(o.prio)) o.prio = p;
    }
    return { objs, anyKeys, excluded };
  }
  function compare(pair) {
    if (!pair.A.rows || !pair.B.rows || pair.A.err || pair.B.err) return null;
    const A = aggregate(pair.A), B = aggregate(pair.B), common = [], delta = [], onlyA = [];
    for (const [k, b] of B.objs) { const a = A.objs.get(k); if (a) common.push({ a, b }); else delta.push(b); }
    for (const [k, a] of A.objs) if (!B.objs.has(k)) onlyA.push(a);
    const uniq = m => [...new Set([...m.values()].map(o => o.prio))].sort(prioSort);
    const matrix = {}; for (const { a, b } of common) { const r = matrix[a.prio] ||= {}; r[b.prio] = (r[b.prio] || 0) + 1; }
    const dType = {}, dPrio = {}; for (const b of delta) { const r = dType[b.type || '—'] ||= {}; r[b.prio] = (r[b.prio] || 0) + 1; dPrio[b.prio] = (dPrio[b.prio] || 0) + 1; }
    const inAOther = {}; let inAOtherN = 0; for (const b of delta) { const p = A.anyKeys.get(b.key); if (p) { inAOther[p] = (inAOther[p] || 0) + 1; inAOtherN++; } }
    const k = 1 - S.fp / 100, dF = delta.reduce((s, o) => s + o.n, 0);
    return { A, B, nA: A.objs.size, nB: B.objs.size, nC: common.length, nD: delta.length, nOA: onlyA.length, common, delta, onlyA, aP: uniq(A.objs), bP: uniq(B.objs), matrix, dType, dPrio, inAOther, inAOtherN, dF, nDfp: Math.round(delta.length * k), dFfp: Math.round(dF * k) };
  }
  const objectRows = r => [
    ...r.common.map(({ a, b }) => ({ st: 'Common', name: b.name, type: b.type, ap: a.prio, bp: b.prio, an: a.n, bn: b.n, pkg: b.pkg || a.pkg })),
    ...r.delta.map(b => { const p = r.A.anyKeys.get(b.key); return { st: 'Additional', name: b.name, type: b.type, ap: p ? '(' + p + ')' : '', bp: b.prio, an: '', bn: b.n, pkg: b.pkg }; }),
    ...r.onlyA.map(a => ({ st: 'Only in A', name: a.name, type: a.type, ap: a.prio, bp: '', an: a.n, bn: '', pkg: a.pkg }))
  ];

  function render(el, H) {
    const { esc, toast, saveBlob } = H, $ = (s, r = el) => r.querySelector(s), $$ = (s, r = el) => [...r.querySelectorAll(s)];
    const pairTitle = (p, i) => p.name || 'System ' + (i + 1);
    const findPair = id => S.pairs.find(p => p.id === +id);
    const prioritiesSeen = () => {
      const set = new Set(['P1', 'P2', 'P3']);
      for (const p of S.pairs) for (const s of [p.A, p.B]) if (s.rows && s.cols.prio >= 0) for (let i = 0; i < s.rows.length && set.size < 14; i++) set.add(normPrio(s.rows[i][s.cols.prio]));
      set.delete('—'); return [...set].sort(prioSort);
    };

    async function loadFile(slot, file) {
      S.ran = false; Object.assign(slot, { fileName: file.name, size: file.size, status: 'Reading…', err: false, rows: null }); paint();
      try {
        const X = await loadLib(); slot.buf = await file.arrayBuffer();
        const wb = X.read(slot.buf, { type: 'array', sheetRows: 2 });
        slot.sheets = wb.SheetNames.map(n => ({ name: n, headers: (X.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })[0] || []).map(String) }));
        const usable = slot.sheets.filter(s => { const c = detectCols(s.headers); return c.name >= 0 && c.prio >= 0; });
        const pick = usable.find(s => /mapped_data/i.test(s.name)) || usable[0] || slot.sheets[0];
        await selectSheet(slot, pick.name);
      } catch (e) { slot.status = 'Could not read this file. Use .xlsx, .xls or .csv.'; slot.err = true; paint(); }
    }
    async function selectSheet(slot, name) {
      S.ran = false; slot.sheet = name; slot.status = 'Reading sheet…'; slot.rows = null; paint();
      await new Promise(r => setTimeout(r, 30));
      try {
        const X = await loadLib(), wb = X.read(slot.buf, { type: 'array', sheets: [name], dense: true });
        const all = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: false });
        slot.headers = (all[0] || []).map(String); slot.rows = all.slice(1); slot.cols = detectCols(slot.headers); validate(slot);
      } catch (e) { slot.status = 'Could not read sheet "' + name + '".'; slot.err = true; }
      paint();
    }

    function slotHtml(p, w) {
      const s = p[w], label = w === 'A' ? p.aLabel : p.bLabel;
      const cols = s.rows ? `<details ${s.err ? 'open' : ''}><summary class="hint">Columns</summary><div class="dlt-cols">${COLS.map(([k, l]) => `<label>${l}<select data-col="${k}" data-pair="${p.id}" data-slot="${w}"><option value="-1">—</option>${s.headers.map((h, i) => `<option value="${i}" ${s.cols[k] === i ? 'selected' : ''}>${esc(h || '(column ' + (i + 1) + ')')}</option>`).join('')}</select></label>`).join('')}</div></details>` : '';
      const sheet = s.sheets.length > 1 ? `<label class="dlt-sheet">Sheet<select data-sheet data-pair="${p.id}" data-slot="${w}">${s.sheets.map(x => `<option ${x.name === s.sheet ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : '';
      return `<div class="dlt-slot ${s.rows && !s.err ? 'ok' : ''}" data-drop="${p.id}:${w}">
        <div class="dlt-slot-h"><span><span class="chip">${w}</span> <b>${esc(label)}</b> <span class="hint">${w === 'A' ? 'baseline' : 'compared'}</span></span>
          <label class="btn">${s.fileName ? 'Replace file' : 'Choose file'}<input type="file" hidden accept=".xlsx,.xls,.xlsm,.csv" data-file data-pair="${p.id}" data-slot="${w}"></label></div>
        ${s.fileName ? `<div class="dlt-fn">${esc(s.fileName)} <span class="hint">${fmtBytes(s.size)}</span></div>` : '<div class="hint">Drop an ATC or CVA result workbook here, or choose a file.</div>'}
        ${s.status ? `<div class="hint ${s.err ? 'dlt-err' : ''}">${esc(s.status)}</div>` : ''}${sheet}${cols}</div>`;
    }
    function matrixTable(rowsK, colsK, get, rowHead, colHead) {
      const colT = colsK.map(c => rowsK.reduce((s, r) => s + (get(r, c) || 0), 0));
      return `<div class="table-wrap"><table><thead><tr><th>${esc(rowHead)} ↓ / ${esc(colHead)} →</th>${colsK.map(c => `<th class="dlt-n">${esc(c)}</th>`).join('')}<th class="dlt-n">Total</th></tr></thead><tbody>
        ${rowsK.map(r => { const v = colsK.map(c => get(r, c) || 0); return `<tr><td><b>${esc(r)}</b></td>${v.map(x => `<td class="dlt-n">${x ? fmt(x) : '·'}</td>`).join('')}<td class="dlt-n"><b>${fmt(v.reduce((a, b) => a + b, 0))}</b></td></tr>`; }).join('')}
        <tr class="dlt-total"><td>Total</td>${colT.map(v => `<td class="dlt-n">${fmt(v)}</td>`).join('')}<td class="dlt-n">${fmt(colT.reduce((a, b) => a + b, 0))}</td></tr></tbody></table></div>`;
    }
    function summaryHtml() {
      const rows = S.pairs.map((p, i) => ({ p, i, r: S.results.get(p.id) })).filter(x => x.r);
      if (!rows.length) return `<div class="hint dlt-empty">${S.pairs.some(p => p.A.rows && p.B.rows) ? 'Files or columns changed. Press Compare to calculate.' : 'Load an A and a B file in at least one comparison, then press Compare.'}</div>`;
      const t = rows.reduce((s, { r }) => ({ nA: s.nA + r.nA, nB: s.nB + r.nB, nC: s.nC + r.nC, nD: s.nD + r.nD, nDfp: s.nDfp + r.nDfp, nOA: s.nOA + r.nOA }), { nA: 0, nB: 0, nC: 0, nD: 0, nDfp: 0, nOA: 0 });
      const tr = (c, label, sub, x, cls) => `<tr class="${cls || ''}" ${c}><td><b>${label}</b></td><td>${sub}</td><td class="dlt-n">${fmt(x.nA)}</td><td class="dlt-n">${fmt(x.nB)}</td><td class="dlt-n">${fmt(x.nC)}</td><td class="dlt-n dlt-hot">${fmt(x.nD)}</td><td class="dlt-n dlt-hot">${pct(x.nD, x.nA)}</td><td class="dlt-n">${fmt(x.nDfp)}</td><td class="dlt-n">${pct(x.nDfp, x.nA)}</td><td class="dlt-n">${fmt(x.nOA)}</td></tr>`;
      return `${S.ran ? '' : '<div class="hint dlt-stale">Inputs changed. Showing the previous result. Press Compare to refresh.</div>'}
        <div class="table-wrap"><table><thead><tr><th>System</th><th>A → B</th><th class="dlt-n">A objects</th><th class="dlt-n">B objects</th><th class="dlt-n">Common</th><th class="dlt-n">Additional (B only)</th><th class="dlt-n">Additional %</th><th class="dlt-n">After ${S.fp}% FP</th><th class="dlt-n">% after FP</th><th class="dlt-n">Only in A</th></tr></thead><tbody>
        ${rows.map(({ p, i, r }) => tr(`data-select="${p.id}"`, esc(pairTitle(p, i)), esc(p.aLabel) + ' → ' + esc(p.bLabel), r, 'dlt-click' + (p.id === S.active ? ' sel' : ''))).join('')}
        ${rows.length > 1 ? tr('', 'Total', '', t, 'dlt-total') : ''}</tbody></table></div>`;
    }
    function detailHtml() {
      const p = S.pairs.find(x => x.id === S.active), r = p && S.results.get(p.id);
      if (!r) return `<div class="hint dlt-empty">${p ? 'Load both files for this comparison, then press Compare.' : ''}</div>`;
      const A = esc(p.aLabel), B = esc(p.bLabel), tot = r.nC + r.nD + r.nOA || 1;
      const dTypes = Object.keys(r.dType).sort((x, y) => Object.values(r.dType[y]).reduce((a, b) => a + b, 0) - Object.values(r.dType[x]).reduce((a, b) => a + b, 0));
      const dPr = Object.keys(r.dPrio).sort(prioSort);
      const note = r.inAOtherN ? `<p class="hint">${fmt(r.inAOtherN)} of the additional objects do appear in ${A}, but only at a priority you left out of scope (${Object.keys(r.inAOther).sort(prioSort).map(k => esc(k) + ': ' + fmt(r.inAOther[k])).join(', ')}). Bringing those priorities into scope would lower the additional count to ${fmt(r.nD - r.inAOtherN)}.</p>` : '';
      const kpi = (l, v, hot) => `<div class="dlt-kpi ${hot ? 'hot' : ''}"><span>${l}</span><b>${v}</b></div>`;
      return `<div class="dlt-kpis">${kpi(A + ' objects (baseline)', fmt(r.nA))}${kpi(B + ' objects', fmt(r.nB))}${kpi('Common to both', fmt(r.nC))}${kpi('Additional from ' + B, fmt(r.nD), 1)}${kpi('Additional vs ' + A, pct(r.nD, r.nA), 1)}${kpi('Additional after ' + S.fp + '% FP', fmt(r.nDfp) + ' · ' + pct(r.nDfp, r.nA))}</div>
        <div class="dlt-bar" role="img" aria-label="Common ${r.nC}, additional ${r.nD}, only in A ${r.nOA}"><span class="c" style="width:${r.nC / tot * 100}%"></span><span class="d" style="width:${r.nD / tot * 100}%"></span><span class="o" style="width:${r.nOA / tot * 100}%"></span></div>
        <p class="hint">Common ${fmt(r.nC)} · Additional from ${B} ${fmt(r.nD)} · Only in ${A} ${fmt(r.nOA)} · In scope: ${S.prios.map(esc).join(', ')} · Rows excluded: ${A} ${fmt(r.A.excluded)}, ${B} ${fmt(r.B.excluded)} · Additional findings: ${fmt(r.dF)} (${fmt(r.dFfp)} after FP)</p>${note}
        <div class="dlt-grid2"><div><h4>Common objects by priority</h4><p class="hint">Rows: highest priority in ${A}. Columns: in ${B}.</p>
          ${r.nC ? matrixTable(r.aP.filter(x => r.matrix[x]), r.bP.filter(c => r.aP.some(a => (r.matrix[a] || {})[c])), (a, b) => (r.matrix[a] || {})[b], p.aLabel, p.bLabel) : '<p class="hint">No objects in common.</p>'}</div>
          <div><h4>Additional objects by type and priority</h4><p class="hint">Objects only ${B} flags, by their highest ${B} priority.</p>
          ${r.nD ? matrixTable(dTypes, dPr, (t, pr) => (r.dType[t] || {})[pr], 'Type', p.bLabel + ' priority') : '<p class="hint">No additional objects.</p>'}</div></div>
        <p class="hint">The object-level list (${fmt(tot)} objects with status, priorities, findings and package) is in the Excel export.</p>`;
    }

    function paint() {
      el.innerHTML = `<div class="cva dlt">
        <section class="cva-card"><header class="cva-card-h"><div><h3>Settings</h3><p class="hint">Objects are matched on name and type and counted once, at their highest priority. Only the priorities ticked count.</p></div></header>
          <div class="dlt-set"><div class="dlt-prios"><span class="hint">Priorities in scope</span><div class="row">${prioritiesSeen().map(x => `<label class="chip dlt-pchip"><input type="checkbox" data-prio value="${esc(x)}" ${S.prios.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div></div>
          <label>Exclude findings containing<input type="text" data-exclude value="${esc(S.exclude)}" placeholder="words, comma-separated"></label>
          <label>False positives in B (%)<input type="number" data-fp min="0" max="100" step="1" value="${S.fp}"></label>
          <label>Match objects on<select data-keymode><option value="nt" ${S.keyMode === 'nt' ? 'selected' : ''}>Name + type</option><option value="n" ${S.keyMode === 'n' ? 'selected' : ''}>Name only</option></select></label></div></section>
        <section class="cva-card"><header class="cva-card-h"><div><h3>Comparisons</h3><p class="hint">One row per system: A is the baseline (e.g. RISE), B is compared against it (e.g. CVA). Drop a workbook on each side.</p></div>
          <div class="row"><button type="button" data-add>+ Add comparison</button><button type="button" class="primary" data-compare>Compare</button></div></header>
          ${S.pairs.map((p, i) => `<div class="dlt-pair"><div class="dlt-pair-h">
            <label class="dlt-wide">System name<input type="text" data-field="name" data-pair="${p.id}" value="${esc(p.name)}" placeholder="e.g. D31 Chemicals"></label>
            <label>Label A<input type="text" data-field="aLabel" data-pair="${p.id}" value="${esc(p.aLabel)}"></label>
            <label>Label B<input type="text" data-field="bLabel" data-pair="${p.id}" value="${esc(p.bLabel)}"></label>
            ${S.pairs.length > 1 ? `<button type="button" class="cva-sm" data-remove="${p.id}" aria-label="Remove ${esc(pairTitle(p, i))}">Remove</button>` : ''}</div>
            <div class="dlt-slots">${slotHtml(p, 'A')}${slotHtml(p, 'B')}</div></div>`).join('')}</section>
        <section class="cva-card"><header class="cva-card-h"><h3>All systems</h3><button type="button" data-export ${[...S.results.values()].some(Boolean) ? '' : 'hidden'}>Export to Excel</button></header><div data-summary>${summaryHtml()}</div></section>
        <section class="cva-card"><div class="seg dlt-tabs" role="tablist">${S.pairs.map((p, i) => `<button type="button" role="tab" aria-checked="${p.id === S.active}" data-select="${p.id}">${esc(pairTitle(p, i))}</button>`).join('')}</div><div data-detail>${detailHtml()}</div></section></div>`;
      wire();
    }
    const refresh = () => { $('[data-summary]').innerHTML = summaryHtml(); $('[data-detail]').innerHTML = detailHtml(); $$('.dlt-tabs [data-select]').forEach((b, i) => { b.textContent = pairTitle(S.pairs[i], i); b.setAttribute('aria-checked', S.pairs[i].id === S.active); }); $$('[data-summary] [data-select]').forEach(tr => tr.onclick = () => select(tr.dataset.select)); const ex = $('[data-export]'); ex.hidden = ![...S.results.values()].some(Boolean); };
    const run = () => { S.ran = true; S.results = new Map(); for (const p of S.pairs) S.results.set(p.id, compare(p)); if (!S.pairs.find(p => p.id === S.active)) S.active = S.pairs[0]?.id; paint(); };
    const select = id => { S.active = +id; paint(); };
    let timer;
    function wire() {
      $$('[data-select]').forEach(b => b.onclick = () => select(b.dataset.select));
      $$('[data-prio]').forEach(c => c.onchange = () => { S.prios = $$('[data-prio]:checked').map(i => i.value); saveOpts(); if (S.ran) run(); });
      $('[data-exclude]').oninput = e => { S.exclude = e.target.value; saveOpts(); clearTimeout(timer); timer = setTimeout(() => S.ran && run(), 400); };
      $('[data-fp]').oninput = e => { S.fp = Math.min(100, Math.max(0, +e.target.value || 0)); saveOpts(); if (S.ran) { S.results = new Map(S.pairs.map(p => [p.id, compare(p)])); refresh(); } };
      $('[data-keymode]').onchange = e => { S.keyMode = e.target.value; saveOpts(); if (S.ran) run(); };
      $('[data-add]').onclick = () => { const p = newPair(); S.pairs.push(p); S.active = p.id; paint(); };
      $('[data-compare]').onclick = () => { if (!S.pairs.some(p => p.A.rows && p.B.rows)) return toast('Load an A and a B file first'); run(); $('[data-summary]').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      $$('[data-remove]').forEach(b => b.onclick = () => { S.ran = false; S.pairs = S.pairs.filter(p => p.id !== +b.dataset.remove); S.results.delete(+b.dataset.remove); paint(); });
      $$('[data-field]').forEach(i => i.oninput = () => { findPair(i.dataset.pair)[i.dataset.field] = i.value; clearTimeout(timer); timer = setTimeout(refresh, 250); });
      $$('[data-file]').forEach(i => i.onchange = () => { if (i.files[0]) loadFile(findPair(i.dataset.pair)[i.dataset.slot], i.files[0]); });
      $$('[data-sheet]').forEach(i => i.onchange = () => selectSheet(findPair(i.dataset.pair)[i.dataset.slot], i.value));
      $$('[data-col]').forEach(i => i.onchange = () => { S.ran = false; const s = findPair(i.dataset.pair)[i.dataset.slot]; s.cols[i.dataset.col] = +i.value; validate(s); paint(); });
      $$('[data-drop]').forEach(z => {
        z.ondragover = e => { e.preventDefault(); z.classList.add('over'); }; z.ondragleave = () => z.classList.remove('over');
        z.ondrop = e => { e.preventDefault(); z.classList.remove('over'); const [id, w] = z.dataset.drop.split(':'), f = e.dataTransfer.files[0]; if (f) loadFile(findPair(id)[w], f); };
      });
      $$('[data-summary] [data-select]').forEach(tr => tr.onclick = () => select(tr.dataset.select));
      $('[data-export]').onclick = exportXlsx;
    }

    async function exportXlsx() {
      try {
        const X = await loadLib(), wb = X.utils.book_new(), used = new Set();
        const sn = s => { let n = s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), i = 2; while (used.has(n)) n = n.slice(0, 28) + '_' + i++; used.add(n); return n; };
        const sum = [['System', 'A', 'B', 'Priorities', 'Excluded keywords', 'A objects', 'B objects', 'Common', 'Additional (B only)', 'Additional %', 'FP %', 'Additional after FP', '% after FP', 'Only in A', 'Additional present in A at other priority']];
        S.pairs.forEach((p, i) => { const r = S.results.get(p.id); if (r) sum.push([pairTitle(p, i), p.aLabel, p.bLabel, S.prios.join(', '), S.exclude, r.nA, r.nB, r.nC, r.nD, r.nA ? r.nD / r.nA : null, S.fp / 100, r.nDfp, r.nA ? r.nDfp / r.nA : null, r.nOA, r.inAOtherN]); });
        const ws = X.utils.aoa_to_sheet(sum); ws['!cols'] = sum[0].map(() => ({ wch: 20 })); X.utils.book_append_sheet(wb, ws, sn('Summary'));
        S.pairs.forEach((p, i) => {
          const r = S.results.get(p.id); if (!r) return; const t = pairTitle(p, i), dP = Object.keys(r.dPrio).sort(prioSort);
          const m = [[`Common: ${p.aLabel} priority ↓ / ${p.bLabel} priority →`, ...r.bP]]; r.aP.forEach(a => m.push([a, ...r.bP.map(b => (r.matrix[a] || {})[b] || 0)]));
          m.push([]); m.push([`Additional: type ↓ / ${p.bLabel} priority →`, ...dP]); Object.keys(r.dType).forEach(ty => m.push([ty, ...dP.map(pr => (r.dType[ty] || {})[pr] || 0)]));
          X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(m), sn(t + ' matrix'));
          const o = [['Object', 'Type', 'Status', p.aLabel + ' priority', p.bLabel + ' priority', p.aLabel + ' findings', p.bLabel + ' findings', 'Package']];
          objectRows(r).forEach(x => o.push([x.name, x.type, x.st, x.ap, x.bp, x.an, x.bn, x.pkg]));
          const wo = X.utils.aoa_to_sheet(o); wo['!cols'] = [{ wch: 34 }, { wch: 8 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 18 }]; X.utils.book_append_sheet(wb, wo, sn(t + ' objects'));
        });
        const out = X.write(wb, { type: 'array', bookType: 'xlsx' });
        await saveBlob(new Blob([out], { type: XLSX_MIME }), 'SAP_Scope_Delta.xlsx');
      } catch (e) { toast(e.message || 'Export failed'); }
    }
    paint();
  }
  window.DHSapDelta = { render };
})();
