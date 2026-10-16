// DevHub › SAP tools › SAP CVA Orchestrator (UI). The engine lives in sap-cva-core.js and runs in a Web Worker.
(function () {
  'use strict';
  const MAX_FILES = 11;
  const LS_APPS = 'dh-sapcva-apps', LS_OPTS = 'dh-sapcva-opts';
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  let libP = null;
  const loadLib = () => libP ||= new Promise((ok, no) => {
    if (window.XLSX && window.XLSX.CFB) return ok(window.XLSX);
    const s = document.createElement('script'); s.src = 'vendor/xlsx-style.min.js';
    s.onload = () => ok(window.XLSX); s.onerror = () => { libP = null; no(new Error('Could not load the Excel library.')); };
    document.head.appendChild(s);
  });

  // state survives switching tools during the session
  const S = window.__sapCvaState ||= {
    apps: {}, appsName: '', appsDirty: false, appsHandle: null, appsHandleLoaded: false, historyIn: undefined,
    rows: [], outDir: null, outDirLoaded: false, history: null, historyName: '', results: null, log: [],
    opts: Object.assign({ summary: true, summaryName: 'SAP_CVA_Executive_Summary.xlsx', keepHistory: true, subsequent: true, historyName: 'SAP_CVA_History.json' }, ls.get(LS_OPTS, {}))
  };
  // Remove what earlier versions stored on this device (applications, file name, folder handles)
  try { [LS_APPS, LS_APPS + '-name', LS_APPS + '-dirty'].forEach(k => localStorage.removeItem(k)); } catch {}
  setTimeout(() => { try { folderStore.del(); appsFileStore.del(); } catch {} }, 0);
  let worker = null;
  // Nothing about applications or folders is kept between visits (security): the applications.json is opened every time and the output folder is chosen every time.
  const idb = (mode, fn) => new Promise((ok, no) => {
    let rq; try { rq = indexedDB.open('dh-sapcva', 1); } catch (e) { return no(e); }
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => no(rq.error);
    rq.onsuccess = () => { try { const tx = rq.result.transaction('kv', mode), r = fn(tx.objectStore('kv')); tx.oncomplete = () => ok(r && r.result); tx.onerror = () => no(tx.error); } catch (e) { no(e); } };
  });
  const folderStore = { get: () => idb('readonly', s => s.get('outDir')).catch(() => null), set: h => idb('readwrite', s => s.put(h, 'outDir')).catch(() => {}), del: () => idb('readwrite', s => s.delete('outDir')).catch(() => {}) };
  const appsFileStore = { get: () => idb('readonly', s => s.get('appsFile')).catch(() => null), set: h => idb('readwrite', s => s.put(h, 'appsFile')).catch(() => {}), del: () => idb('readwrite', s => s.delete('appsFile')).catch(() => {}) };
  const canPickFolder = () => typeof window.showDirectoryPicker === 'function';
  const canOpenFile = () => typeof window.showOpenFilePicker === 'function';

  function render(el, H) {
    const { esc, toast, saveBlob } = H, $ = (s, r = el) => r.querySelector(s), $$ = (s, r = el) => [...r.querySelectorAll(s)];
    const appIds = () => Object.keys(S.apps);
    el.innerHTML = `
      <div class="cva">
        <section class="cva-card">
          <header class="cva-card-h"><div><h3>1 · Applications</h3><p class="hint">Application ID → system number, system name and business area. Same <code>applications.json</code> format as the desktop tool.</p></div>
            <span class="chip" data-appcount></span></header>
          <div class="row cva-appbar">
            ${canOpenFile() ? '<button type="button" class="primary" data-appopen>Open applications.json</button>' : '<label class="btn primary">Open applications.json<input type="file" accept=".json,application/json" hidden data-appfile></label>'}
            <button type="button" data-appsave>Save applications.json</button>
            <span class="cva-dirty" data-appdirty hidden>● Unsaved changes</span>
          </div>
          <div class="cva-apped" data-apped></div>
        </section>

        <section class="cva-card">
          <header class="cva-card-h"><div><h3>2 · Source files</h3><p class="hint">One CVA findings workbook (.xlsx) per row — up to ${MAX_FILES}. Drop several files here to add a row for each.</p></div>
            <button type="button" class="primary" data-addrow>+ Add file row</button></header>
          <div class="cva-files" data-files></div>
        </section>

        <section class="cva-card">
          <header class="cva-card-h"><div><h3>3 · Outputs</h3><p class="hint">Each file gives an 18-sheet <code>…_CVA_Report.xlsx</code> — a category Summary first. Optional extras below.</p></div></header>
          <div class="cva-outdir">
            <span class="cva-outdir-l">Output folder</span>
            ${canPickFolder() ? `<button type="button" data-outpick>Choose folder…</button><span class="cva-outdir-name" data-outname></span><button type="button" class="ghost cva-sm" data-outclear hidden>Clear</button>`
              : '<span class="hint">This browser saves to your <b>Downloads</b> folder. Open DevHub in Chrome or Edge on a computer to choose a folder.</span>'}
          </div>
          <div class="cva-opts">
            <label class="check"><input type="checkbox" data-o="summary"> Create compact consolidated summary</label>
            <input type="text" data-o="summaryName" aria-label="Summary file name">
            <label class="check"><input type="checkbox" data-o="keepHistory"> Keep a trend history JSON</label>
            <input type="text" data-o="historyName" aria-label="History file name">
            <label class="check" data-subrow><input type="checkbox" data-o="subsequent"> Subsequent run — append to an existing history</label>
            <div class="row" data-subrow><label class="btn">Open history JSON<input type="file" accept=".json,application/json" hidden data-histfile></label><span class="hint" data-histname></span></div>
          </div>
          <p class="hint cva-hist-hint">Checked: this run's results are appended to the history you open. Unchecked: a fresh history is started. The summary workbook lists the full history when history is kept.</p>
          <div class="row cva-tpl"><span class="hint">Need the file format?</span>
            <select data-tpl><option value="applications">Applications database (applications.json)</option><option value="history">Trend history (SAP_CVA_History.json)</option></select>
            <button type="button" data-tpldl>Download template</button></div>
        </section>

        <div class="cva-run">
          <button type="button" class="primary cva-go" data-run>Run processing</button>
          <button type="button" data-rerun hidden title="Clear the results and log, then process the same files again">↻ Re-run</button>
          <span class="hint" data-why></span>
          <button type="button" class="danger" data-clearall title="Remove the source files, created files and log. Applications and settings stay.">Clear all</button>
        </div>
        <div class="cva-prog" data-prog hidden><div class="progress"><span style="width:0"></span></div></div>
        <div class="cva-results" data-results hidden></div>
        <details class="cva-logbox" data-logbox ${S.log.length ? 'open' : ''}><summary>Processing log <button type="button" class="ghost" data-clearlog>Clear</button></summary><pre class="cva-log" data-log></pre></details>
      </div>`;

    // ---------- log ----------
    const logEl = $('[data-log]');
    const ts = () => new Date().toTimeString().slice(0, 8);
    const log = msg => { S.log.push(`[${ts()}] ${msg}`); if (S.log.length > 2000) S.log.splice(0, S.log.length - 2000); logEl.textContent = S.log.join('\n'); logEl.scrollTop = logEl.scrollHeight; };
    logEl.textContent = S.log.join('\n');
    $('[data-clearlog]').onclick = e => { e.preventDefault(); S.log = []; logEl.textContent = ''; };

    // ---------- applications ----------
    const saveApps = () => {};   // in memory only
    const paintAppCount = () => {
      const n = appIds().length;
      $('[data-appcount]').textContent = n ? `${n} application${n === 1 ? '' : 's'}${S.appsName ? ' · ' + S.appsName : ''}` : 'None loaded';
      $('[data-appdirty]').hidden = !S.appsDirty;
      const sv = $('[data-appsave]'); sv.classList.toggle('primary', !!S.appsDirty); sv.disabled = !n;
      sv.textContent = S.appsHandle ? `Save to ${S.appsHandle.name}` : 'Save applications.json';
    };
    const alertBox = msg => { const r = $('[data-results]'); r.hidden = false; r.innerHTML = `<div class="out err">${esc(msg)}</div>`; };
    function loadAppsText(text, name) {
      const map = SapCva.parseApplications(JSON.parse(text.replace(/^﻿/, '')));
      S.apps = map; S.appsName = name; S.appsDirty = false; saveApps();
      log(`Loaded ${Object.keys(map).length} application(s) from ${name}`); toast(`Loaded ${Object.keys(map).length} applications`);
      paintAppCount(); paintAppEditor(); paintFiles();
    }
    const appErr = err => { toast('Applications JSON error'); log('Applications JSON error: ' + err.message.replace(/\n+/g, ' ')); alertBox(err.message); };
    const fileInput = $('[data-appfile]');
    if (fileInput) fileInput.onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { loadAppsText(await f.text(), f.name); } catch (err) { appErr(err); } };
    const openBtn = $('[data-appopen]');
    if (openBtn) openBtn.onclick = async () => {   // Chrome/Edge: keep the file handle so Save writes back into the same file
      try {
        const [h] = await window.showOpenFilePicker({ id: 'sap-cva-apps', types: [{ description: 'Applications JSON', accept: { 'application/json': ['.json'] } }] });
        const f = await h.getFile(); loadAppsText(await f.text(), f.name); S.appsHandle = h; paintAppCount();
      } catch (err) { if (err.name !== 'AbortError') appErr(err); }
    };
    $('[data-appsave]').onclick = async () => {
      if (!appIds().length) return toast('No applications to save yet');
      const json = JSON.stringify(S.apps, null, 2) + '\n', name = S.appsName || 'applications.json';
      if (S.appsHandle) {
        try {
          const o = { mode: 'readwrite' };
          if ((await S.appsHandle.queryPermission(o)) !== 'granted' && (await S.appsHandle.requestPermission(o)) !== 'granted') throw new Error('permission');
          const w = await S.appsHandle.createWritable(); await w.write(json); await w.close();
          S.appsDirty = false; saveApps(); paintAppCount(); log(`Saved ${appIds().length} application(s) to ${S.appsHandle.name}`); toast(`Saved to ${S.appsHandle.name}`); return;
        } catch (e) { log(`Could not write to ${S.appsHandle.name} — downloading a copy instead`); }
      }
      await saveBlob(new Blob([json], { type: 'application/json' }), name);
      S.appsDirty = false; saveApps(); paintAppCount(); log(`Downloaded ${name} (${appIds().length} applications)`);
    };
    function paintAppEditor() {
      const ed = $('[data-apped]'), list = Object.entries(S.apps), used = new Set(S.rows.map(r => r.app));
      ed.innerHTML = `<div class="table-wrap cva-appwrap"><table class="cva-apptable"><thead><tr><th>Application ID</th><th>System no.</th><th>System name</th><th>Business area</th><th></th></tr></thead><tbody>
        ${list.length ? list.map(([id, d]) => `<tr class="${S.appsNew && S.appsNew.has(id) ? 'cva-new' : ''}"><td class="mono"><b>${esc(id)}</b></td><td class="mono">${esc(d.system_no)}</td><td>${esc(d.system_name)}</td><td>${esc(d.business_area)}</td>
          <td>${used.has(id) ? '<span class="hint">in use</span>' : `<button type="button" class="ghost danger cva-sm" data-del="${esc(id)}" aria-label="Remove ${esc(id)}">✕</button>`}</td></tr>`).join('')
          : '<tr><td colspan="5" class="hint">No applications yet — open your applications.json, or add them below.</td></tr>'}
        </tbody><tfoot><tr class="cva-newapp"><td><input data-n="id" placeholder="Application ID"></td><td><input data-n="system_no" placeholder="System no."></td><td><input data-n="system_name" placeholder="System name"></td><td><input data-n="business_area" placeholder="Business area"></td><td><button type="button" class="primary cva-sm" data-addapp>+ Add</button></td></tr></tfoot></table></div>
        <p class="hint">Applications are kept only while this page is open and are not stored on this device: open your applications.json each time. After adding or removing one, use <b>${S.appsHandle ? 'Save to ' + esc(S.appsHandle.name) : 'Save applications.json'}</b> to update the file${S.appsHandle ? '' : ' (it downloads a new copy)'}.</p>`;
      $$('[data-del]', ed).forEach(b => b.onclick = () => { delete S.apps[b.dataset.del]; S.appsDirty = true; saveApps(); log(`Removed application ${b.dataset.del}`); paintAppEditor(); paintAppCount(); paintFiles(); });
      const add = () => {
        const v = Object.fromEntries($$('[data-n]', ed).map(i => [i.dataset.n, i.value.trim()]));
        if (!v.id || !v.system_no || !v.system_name || !v.business_area) return toast('Fill in all four fields');
        if (S.apps[v.id]) return toast(`${v.id} already exists`);
        S.apps[v.id] = { system_no: v.system_no, system_name: v.system_name, business_area: v.business_area }; S.appsDirty = true;
        (S.appsNew ||= new Set()).add(v.id); saveApps(); log(`Added application ${v.id} (${v.system_no} · ${v.system_name})`);
        paintAppEditor(); paintAppCount(); paintFiles(); $('[data-n="id"]', ed).focus();
      };
      $('[data-addapp]', ed).onclick = add;
      $$('[data-n]', ed).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') add(); });
    }

    // ---------- file rows ----------
    const addRow = () => { if (S.rows.length >= MAX_FILES) { toast(`Maximum ${MAX_FILES} files per run`); return null; } const r = { file: null, name: '', sheets: [], sheet: '', app: '', date: today() }; S.rows.push(r); return r; };
    async function loadInto(row, file) {
      try {
        const X = await loadLib();
        const wb = X.read(await file.arrayBuffer(), { type: 'array', bookSheets: true });
        Object.assign(row, { file, name: file.name, sheets: wb.SheetNames, sheet: wb.SheetNames[0] || '' });
        log(`Row ${S.rows.indexOf(row) + 1}: loaded ${file.name}`);
      } catch (e) { toast('Could not read ' + file.name); log(`Failed to read ${file.name}: ${e.message}`); }
      paintFiles();
    }
    function paintFiles() {
      const box = $('[data-files]');
      if (!S.rows.length) { box.innerHTML = `<div class="drop cva-drop"><p class="drop-title">Drop CVA workbooks here</p><p class="hint">or use <b>+ Add file row</b>. Files stay on your device.</p></div>`; }
      else box.innerHTML = `<div class="table-wrap cva-ft"><table><thead><tr><th>Input file</th><th>Worksheet</th><th>Application ID *</th><th>System</th><th>Scan date *</th><th></th></tr></thead><tbody>
        ${S.rows.map((r, i) => { const d = S.apps[r.app] || {}; return `<tr data-i="${i}">
          <td>${r.file ? `<span class="cva-fn" title="${esc(r.name)}">${esc(r.name)}</span> <label class="btn ghost cva-sm">Change<input type="file" accept=".xlsx,.xlsm" hidden data-pick></label>` : `<label class="btn primary cva-sm">Load file<input type="file" accept=".xlsx,.xlsm" hidden data-pick></label>`}</td>
          <td><select data-sheet ${r.sheets.length ? '' : 'disabled'}>${r.sheets.map(s => `<option ${s === r.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('') || '<option>—</option>'}</select></td>
          <td><select data-app><option value="">Select…</option>${appIds().map(id => `<option value="${esc(id)}" ${id === r.app ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></td>
          <td class="cva-sys">${d.system_no ? `<b class="mono">${esc(d.system_no)}</b><span class="hint">${esc(d.system_name)}</span>` : '<span class="hint">—</span>'}</td>
          <td><input type="date" data-date value="${esc(r.date)}"></td>
          <td><button type="button" class="ghost danger" data-rm aria-label="Remove row">✕</button></td></tr>`; }).join('')}</tbody></table></div>`;
      $$('tr[data-i]', box).forEach(tr => {
        const r = S.rows[+tr.dataset.i];
        $('[data-pick]', tr).onchange = e => e.target.files[0] && loadInto(r, e.target.files[0]);
        $('[data-sheet]', tr).onchange = e => { r.sheet = e.target.value; };
        $('[data-app]', tr).onchange = e => { r.app = e.target.value; paintFiles(); paintAppEditor(); };
        $('[data-date]', tr).onchange = e => { r.date = e.target.value; check(); };
        $('[data-rm]', tr).onclick = () => { S.rows.splice(S.rows.indexOf(r), 1); paintFiles(); paintAppEditor(); };
      });
      check();
    }
    $('[data-addrow]').onclick = () => { if (addRow()) { log(`Added row ${S.rows.length}.`); paintFiles(); } };
    const filesCard = $('[data-files]').closest('.cva-card');
    ['dragenter', 'dragover'].forEach(ev => filesCard.addEventListener(ev, e => { e.preventDefault(); filesCard.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => filesCard.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || !filesCard.contains(e.relatedTarget)) filesCard.classList.remove('over'); }));
    filesCard.addEventListener('drop', e => {
      const fs = [...e.dataTransfer.files].filter(f => /\.xls[xm]$/i.test(f.name));
      if (!fs.length) return toast('Drop .xlsx files');
      fs.forEach(f => { const r = S.rows.find(x => !x.file) || addRow(); if (r) loadInto(r, f); });
    });

    // ---------- options ----------
    $$('[data-o]').forEach(i => {
      const k = i.dataset.o;
      if (i.type === 'checkbox') i.checked = !!S.opts[k]; else i.value = S.opts[k];
      i.onchange = i.oninput = () => { S.opts[k] = i.type === 'checkbox' ? i.checked : i.value.trim(); ls.set(LS_OPTS, S.opts); paintOpts(); };
    });
    function paintOpts() {
      $('[data-o="summaryName"]').disabled = !S.opts.summary;
      $('[data-o="historyName"]').disabled = !S.opts.keepHistory;
      $$('[data-subrow]').forEach(x => x.hidden = !S.opts.keepHistory);
      $('[data-subrow] input[data-o="subsequent"]').checked = S.opts.subsequent;
      $('[data-histname]').textContent = S.history ? `${S.historyName} · ${S.history.length} run${S.history.length === 1 ? '' : 's'} recorded` : 'No history opened — a new one will be started';
      $('.cva-hist-hint').hidden = !S.opts.keepHistory;
      check();
    }
    $('[data-histfile]').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { const d = JSON.parse((await f.text()).replace(/^﻿/, '')); if (!Array.isArray(d)) throw new Error('expected a JSON list of run records'); S.history = d; S.historyIn = d; S.historyName = f.name; S.opts.historyName = f.name; $('[data-o="historyName"]').value = f.name; ls.set(LS_OPTS, S.opts); log(`History JSON: ${f.name} (${d.length} runs, will append)`); }
      catch (err) { toast('History JSON error'); log(`History JSON error: ${err.message}`); }
      paintOpts();
    };
    $('[data-tpldl]').onclick = () => { const t = SapCva.JSON_TEMPLATES[$('[data-tpl]').value]; saveBlob(new Blob([JSON.stringify(t.content, null, 2)], { type: 'application/json' }), t.filename); log(`Downloaded template: ${t.filename}`); };

    // ---------- output folder ----------
    function paintOutDir() {
      const nm = $('[data-outname]'); if (!nm) return;
      nm.innerHTML = S.outDir ? `<b>${esc(S.outDir.name)}</b> <span class="hint">· reports are saved here after each run</span>` : '<span class="hint">None chosen — files go to Downloads</span>';
      $('[data-outclear]').hidden = !S.outDir; $('[data-outpick]').textContent = S.outDir ? 'Change…' : 'Choose folder…';
    }
    if (canPickFolder()) {
      $('[data-outpick]').onclick = async () => {
        try { const d = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sap-cva-out', startIn: S.outDir || 'documents' }); S.outDir = d; log(`Output folder: ${d.name}`); paintOutDir(); }
        catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder'); }
      };
      $('[data-outclear]').onclick = () => { S.outDir = null; folderStore.del(); log('Output folder cleared — files go to Downloads'); paintOutDir(); };
    }
    async function folderAccess(dir, ask) {
      try { const o = { mode: 'readwrite' }; if ((await dir.queryPermission(o)) === 'granted') return true; return ask ? (await dir.requestPermission(o)) === 'granted' : false; } catch { return false; }
    }
    async function writeToFolder(dir, files) {
      for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }), w = await h.createWritable(); await w.write(f.blob); await w.close(); }
    }

    // ---------- run ----------
    function check() {
      const why = !appIds().length ? 'Open or create an applications.json first.'
        : !S.rows.length ? 'Add at least one file row.'
        : S.rows.some(r => !r.file) ? 'Every row needs a file.'
        : S.rows.some(r => !r.app || !S.apps[r.app]) ? 'Every row needs an Application ID.'
        : S.rows.some(r => !r.date) ? 'Every row needs a scan date.' : '';
      $('[data-run]').disabled = !!why || !!worker; $('[data-why]').textContent = worker ? 'Processing…' : why;
      $('[data-rerun]').hidden = !S.results; $('[data-rerun]').disabled = !!why || !!worker;
      $('[data-clearall]').disabled = !!worker || (!S.rows.length && !S.results && !S.log.length);
    }
    $('[data-run]').onclick = async () => {
      let outOk = false;   // ask for folder access now, while the click still counts as a user action
      if (S.outDir) { outOk = await folderAccess(S.outDir, true); if (!outOk) log(`No permission for folder "${S.outDir.name}" — files will be offered as downloads.`); }
      if (S.historyIn === undefined) S.historyIn = S.history;   // the history as opened, before any run appended to it
      const prog = $('[data-prog]'), bar = $('.progress span', prog), res = $('[data-results]');
      prog.hidden = false; bar.style.width = '2%'; res.hidden = true; $('[data-logbox]').open = true;
      const jobs = [];
      for (const r of S.rows) jobs.push({ name: r.name, sheet: r.sheet, run_date: r.date, app: { id: r.app, ...S.apps[r.app] }, buffer: await r.file.arrayBuffer() });
      worker = new Worker('sap-cva-core.js'); check();
      const t0 = performance.now();
      const finish = () => { worker && worker.terminate(); worker = null; check(); };
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'log') return log(m.text);
        if (m.type === 'progress') { bar.style.width = Math.max(2, m.pct) + '%'; return; }
        finish();
        if (m.type === 'error') { prog.hidden = true; log('ERROR | ' + m.message); alertBox('Processing failed: ' + m.message); return; }
        if (m.history) { S.history = m.history; S.historyName = S.opts.historyName || 'SAP_CVA_History.json'; paintOpts(); }
        S.results = { files: m.results.map(r => ({ name: r.filename, blob: new Blob([r.buf], { type: XLSX_MIME }), compact: r.compact, stats: r.stats })),
          summary: m.summary ? { name: S.opts.summaryName || 'SAP_CVA_Executive_Summary.xlsx', blob: new Blob([m.summary], { type: XLSX_MIME }) } : null,
          history: m.history ? { name: S.opts.historyName || 'SAP_CVA_History.json', blob: new Blob([JSON.stringify(m.history, null, 2)], { type: 'application/json' }) } : null,
          ms: performance.now() - t0 };
        paintResults();
        const all = [...S.results.files, S.results.summary, S.results.history].filter(Boolean);
        if (S.outDir && outOk) writeToFolder(S.outDir, all)
          .then(() => { S.results.savedTo = S.outDir.name; log(`Saved ${all.length} file(s) to folder "${S.outDir.name}"`); toast(`Saved ${all.length} files to ${S.outDir.name}`); paintResults(); })
          .catch(e => { log(`Could not write to "${S.outDir.name}": ${e.message}`); toast('Could not save to the output folder — use Download'); });
        else toast('Processing completed');
      };
      worker.onerror = e => { finish(); prog.hidden = true; log('ERROR | ' + (e.message || 'worker stopped')); alertBox('The background worker stopped. The files may be too large for this device’s memory.'); };
      log(`Run started: ${jobs.length} file(s).`);
      worker.postMessage({ jobs, makeSummary: S.opts.summary, keepHistory: S.opts.keepHistory, subsequent: S.opts.subsequent, history: S.opts.subsequent ? S.historyIn : null }, jobs.map(j => j.buffer));
    };

    // ---------- re-run / clear ----------
    function resetRun() {
      S.results = null; S.log = []; logEl.textContent = ''; $('[data-logbox]').open = false;
      const r = $('[data-results]'); r.hidden = true; r.innerHTML = ''; $('[data-prog]').hidden = true; $('.progress span', $('[data-prog]')).style.width = '0';
      if (S.historyIn !== undefined) { S.history = S.historyIn; paintOpts(); }   // drop what the last run appended
    }
    $('[data-rerun]').onclick = () => { resetRun(); log('Re-run: results and log cleared; processing the same files again.'); $('[data-run]').click(); };
    const clr = $('[data-clearall]');
    clr.onclick = () => {
      if (clr.dataset.armed !== '1') {   // two-step confirm without a browser dialog
        clr.dataset.armed = '1'; clr.textContent = 'Click again to clear'; clr.classList.add('armed');
        clearTimeout(clr._t); clr._t = setTimeout(() => { clr.dataset.armed = ''; clr.textContent = 'Clear all'; clr.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(clr._t); clr.dataset.armed = ''; clr.textContent = 'Clear all'; clr.classList.remove('armed');
      const n = S.rows.length; S.rows = []; resetRun(); paintFiles(); paintAppEditor();
      toast(`Cleared ${n} file${n === 1 ? '' : 's'}, results and log — applications kept`);
    };

    // ---------- results ----------
    function paintResults() {
      const R = S.results, res = $('[data-results]'); check(); if (!R) return;
      const all = [...R.files, R.summary, R.history].filter(Boolean);
      res.hidden = false;
      res.innerHTML = `<div class="result-head"><div><b>${R.files.length} report${R.files.length === 1 ? '' : 's'} ready</b><div class="hint">${(R.ms / 1000).toFixed(1)} s · ${fmtBytes(all.reduce((a, f) => a + f.blob.size, 0))} in total${R.savedTo ? ` · <b class="cva-saved">✓ saved to ${esc(R.savedTo)}</b>` : ''}</div></div>
        <div class="row"><button class="primary" data-zip>Download all (.zip)</button>${window.showDirectoryPicker ? '<button data-folder>Save all to another folder…</button>' : ''}</div></div>
        <div class="table-wrap cva-rt"><table><thead><tr><th>File</th><th>Rows</th><th title="Code match / keyword match / unmapped">Code / kw / unmapped</th><th>Objects</th><th class="p1">P1</th><th class="p2">P2</th><th class="p3">P3</th><th class="p4">P4</th><th></th></tr></thead><tbody>
        ${R.files.map((f, i) => `<tr><td title="${esc(f.name)}">${esc(f.name)}</td><td>${f.stats.rows.toLocaleString()}</td><td>${f.stats.exact.toLocaleString()} / ${f.stats.keyword.toLocaleString()} / ${f.stats.unmapped.toLocaleString()}</td><td>${f.stats.objects.toLocaleString()}</td>
          <td class="p1">${f.compact['Priority 1']}</td><td class="p2">${f.compact['Priority 2']}</td><td class="p3">${f.compact['Priority 3']}</td><td class="p4">${f.compact['Priority 4']}</td><td><button type="button" class="cva-sm" data-dl="${i}" aria-label="Download ${esc(f.name)}">⬇ xlsx</button></td></tr>`).join('')}
        ${R.summary ? `<tr class="cva-extra"><td>${esc(R.summary.name)}</td><td colspan="7" class="hint">Executive summary · Consolidated_View</td><td><button type="button" class="cva-sm" data-dlx="summary" aria-label="Download summary">⬇ xlsx</button></td></tr>` : ''}
        ${R.history ? `<tr class="cva-extra"><td>${esc(R.history.name)}</td><td colspan="7" class="hint">Trend history · ${S.history ? S.history.length : 0} runs</td><td><button type="button" class="cva-sm" data-dlx="history" aria-label="Download history">⬇ json</button></td></tr>` : ''}
        </tbody></table></div>`;
      $$('[data-dl]', res).forEach(b => b.onclick = () => { const f = R.files[+b.dataset.dl]; saveBlob(f.blob, f.name); });
      $$('[data-dlx]', res).forEach(b => b.onclick = () => { const f = R[b.dataset.dlx]; saveBlob(f.blob, f.name); });
      $('[data-zip]', res).onclick = async () => {
        const X = await loadLib(), z = X.CFB.utils.cfb_new();
        for (const f of all) X.CFB.utils.cfb_add(z, f.name, new Uint8Array(await f.blob.arrayBuffer()));
        X.CFB.utils.cfb_del(z, '\u0001Sh33tJ5');
        const zip = X.CFB.write(z, { fileType: 'zip', type: 'array', compression: true });
        saveBlob(new Blob([zip], { type: 'application/zip' }), `SAP_CVA_Reports_${today()}.zip`);
      };
      const fb = $('[data-folder]', res);
      if (fb) fb.onclick = async () => {
        try {
          const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sap-cva-out' });
          for (const f of all) { const h = await dir.getFileHandle(f.name, { create: true }), w = await h.createWritable(); await w.write(f.blob); await w.close(); }
          log(`Saved ${all.length} file(s) to folder "${dir.name}"`); toast(`Saved ${all.length} files to ${dir.name}`);
        } catch (e) { if (e.name !== 'AbortError') toast('Could not save to that folder'); }
      };
    }

    paintAppCount(); paintAppEditor(); paintFiles(); paintOpts(); paintOutDir(); paintResults(); check();
    if (worker) { $('[data-prog]').hidden = false; }
  }

  window.DHSapCva = { render };
})();
