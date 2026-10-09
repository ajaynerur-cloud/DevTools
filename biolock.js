/* DevHub fingerprint unlock (Android app).
 *
 * Opt-in. When it is on:
 *   - the sign-in token lives only in Android's hardware-backed Keystore, protected by the fingerprint
 *     (@capgo/capacitor-native-biometric, accessControl BIOMETRY_ANY), not in the app's normal storage;
 *   - opening the app shows a lock screen. A fingerprint releases the token and the app opens straight from
 *     the copy of your tasks stored on this phone;
 *   - only AFTER that does the app contact the server (wake it, then sync). Nothing is sent while locked,
 *     and unlocking never calls the server's login endpoint, so a sleeping server is not woken by the lock screen.
 *
 * If the fingerprint cannot be used (changed, removed, new phone), the lock screen offers the password sign-in.
 */
(() => {
  'use strict';
  const SERVER = 'devhub-session', FLAG = 'devhub:bio', OPTS = 'devhub:bio-opts', OFFERED = 'devhub:bio-offered:';
  const ANY = 2;                                                     // AccessControl.BIOMETRY_ANY
  const AFTER = { now: 0, '1': 60e3, '5': 300e3, never: Infinity };  // how long away before locking again
  const DH = () => window.DH;
  const NB = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeBiometric;
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const supported = () => isNative() && !!NB();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rd = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const opts = () => ({ after: '1', ...rd(OPTS, {}) });
  const flag = () => rd(FLAG, null);
  const enabled = () => { const s = DH() && DH().session, f = flag(); return supported() && !!f && !!s && !!s.user && f.uid === s.user.id; };
  const locked = () => enabled() && !DH().session.token;
  const errCode = e => { const c = e && (e.code ?? e.errorCode); const n = Number(c); return Number.isFinite(n) ? n : String(c || e && e.message || ''); };
  const cancelled = e => { const c = errCode(e); return [10, 11, 15, 16, 17].includes(c) || /cancel|negative|user/i.test(String(c) + ' ' + (e && e.message || '')); };
  const gone = e => { const c = errCode(e); return c === 21 || /not found|no protected|invalidat|key/i.test(String(e && e.message || '')); };

  let prompting = false, graceUntil = 0;
  const guarded = async fn => { prompting = true; try { return await fn(); } finally { prompting = false; graceUntil = Date.now() + 2000; } };

  async function available() {
    try { const a = await NB().isAvailable({ useFallback: false }); return { ok: !!a.isAvailable, notEnrolled: a.errorCode === 3 }; } catch { return { ok: false }; }
  }
  const noBioMsg = a => a.notEnrolled
    ? 'No fingerprint is set up on this phone. Add one in Android Settings, Security, then try again.'
    : 'This phone cannot use fingerprint unlock (no sensor, or none set up).';

  // keep the (non-secret) user profile in normal storage so the lock screen knows who is signing in
  function stashUser() { try { localStorage.setItem('devhub:user', JSON.stringify(DH().session.user)); } catch {} }
  function dropToken() { try { localStorage.removeItem('devhub:token'); sessionStorage.removeItem('devhub:token'); } catch {} }

  async function enable() {
    const s = DH().session; if (!s.token || !s.user) return { ok: false, msg: 'Sign in first.' };
    const a = await available(); if (!a.ok) return { ok: false, msg: noBioMsg(a) };
    try {
      await guarded(() => NB().setCredentials({ server: SERVER, username: s.user.id, password: s.token, accessControl: ANY, title: 'Turn on fingerprint unlock', negativeButtonText: 'Cancel' }));
      const saved = await NB().isCredentialsSaved({ server: SERVER });
      if (!saved || !saved.isSaved) return { ok: false, msg: 'Could not store your sign-in securely on this phone.' };
    } catch (e) { return { ok: false, msg: cancelled(e) ? 'Cancelled. Fingerprint unlock is still off.' : 'Could not turn on fingerprint unlock.' }; }
    wr(FLAG, { uid: s.user.id, at: Date.now() });
    dropToken(); stashUser();                                         // from now on the token only exists in the Keystore (and in memory this run)
    return { ok: true };
  }
  async function disable() {
    try { await NB().deleteCredentials({ server: SERVER }); } catch {}
    try { localStorage.removeItem(FLAG); } catch {}
    const s = DH().session; if (s.token && s.user) s.save(s.token, s.user, true);   // stay signed in the usual way
  }
  // Called when the account signs out or the session ends: nothing may stay behind
  function forget() {
    try { localStorage.removeItem(FLAG); } catch {}
    if (supported()) { try { NB().deleteCredentials({ server: SERVER }).catch(() => {}); } catch {} }
  }
  // A new token was issued (password change): store it in the Keystore as well
  async function refresh(token, user) {
    if (!enabled()) return;
    try { await guarded(() => NB().setCredentials({ server: SERVER, username: user.id, password: token, accessControl: ANY, title: 'Update fingerprint unlock', negativeButtonText: 'Cancel' })); dropToken(); stashUser(); }
    catch { forget(); DH().session.save(token, user, true); DH().toast('Fingerprint unlock was turned off. Turn it on again in Account.'); }
  }

  /* ---------------- lock screen ---------------- */
  let dlg = null;
  const FP = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11a6 6 0 0 1 12 0v2M9 20c.6-1.4 1-3 1-5v-4a2 2 0 0 1 4 0v4c0 2 .5 4 1.6 5.6M12 16c0 2-.3 3.6-1 5M4 15c.4-1 .6-2.2.6-3.5M20 14c0 2 .3 3.4 1 4.6"/></svg>';
  function lock() {
    if (!enabled()) return;
    const d = DH(); d.relock();
    document.body.classList.add('bio-locked');
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.className = 'bio-lock'; dlg.setAttribute('aria-label', 'DevHub is locked');
      dlg.addEventListener('cancel', e => e.preventDefault());       // the Back button must not dismiss it
      document.body.appendChild(dlg);
    }
    const u = d.session.user;
    dlg.innerHTML = `<div class="bl-in"><div class="bl-ico">${FP}</div><h2>DevHub is locked</h2>
      <p>Signed in as <b>${esc(u.name || u.username)}</b>. Use your fingerprint to open your tasks.</p>
      <button type="button" class="primary wide" id="blGo">Unlock</button>
      <button type="button" class="ghost" id="blPw">Use password instead</button>
      <p class="hint" id="blMsg" role="status"></p></div>`;
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('#blGo').onclick = unlock;
    dlg.querySelector('#blPw').onclick = usePassword;
    setTimeout(unlock, 300);
  }
  const say = t => { const m = dlg && dlg.querySelector('#blMsg'); if (m) m.textContent = t; };
  async function unlock() {
    if (prompting || !dlg) return;
    const d = DH(), uid = d.session.user && d.session.user.id; say('');
    try {
      const c = await guarded(() => NB().getSecureCredentials({ server: SERVER, title: 'Unlock DevHub', subtitle: 'Use your fingerprint', negativeButtonText: 'Cancel' }));
      if (!c || !c.password || c.username !== uid) throw Object.assign(new Error('mismatch'), { code: 21 });
      document.body.classList.remove('bio-locked');
      dlg.close(); dlg.remove(); dlg = null;
      d.unlock(c.password);                                           // opens the local data right away, then wakes the server and syncs
      if (window.DHNotify) { window.DHNotify.checkGate(); window.DHNotify.sync(); }
    } catch (e) {
      if (cancelled(e)) say('Not unlocked. Tap Unlock to try again.');
      else if (gone(e)) { say('Fingerprint unlock is no longer valid on this phone (fingerprints may have changed). Sign in with your password.'); const b = dlg.querySelector('#blGo'); if (b) b.hidden = true; forget(); }
      else say('Could not read your fingerprint. Try again, or use your password.');
    }
  }
  function usePassword() {
    forget();
    const d = DH(); document.body.classList.remove('bio-locked');
    if (dlg) { dlg.close(); dlg.remove(); dlg = null; }
    d.session.clear(); location.hash = 'login'; d.renderNavUser && d.renderNavUser(); d.render();
  }

  // Lock again after the app has been in the background for a while
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (!enabled()) return;
    if (document.visibilityState === 'hidden') { if (!prompting && Date.now() > graceUntil) hiddenAt = Date.now(); return; }
    if (prompting || Date.now() < graceUntil || !hiddenAt || !DH().session.token) { hiddenAt = 0; return; }
    const away = Date.now() - hiddenAt; hiddenAt = 0;
    if (away >= AFTER[opts().after]) lock();
  });

  /* ---------------- opt-in prompt after signing in ---------------- */
  async function offer() {
    const d = DH(); if (!supported() || enabled() || !d.session.token || !d.session.user) return;
    const key = OFFERED + d.session.user.id; if (rd(key, false)) return;
    const a = await available(); if (!a.ok) return;
    wr(key, true);                                                    // ask once; Account has the switch
    const o = document.createElement('dialog'); o.className = 'tk-dialog'; o.setAttribute('aria-label', 'Fingerprint unlock');
    o.innerHTML = `<form method="dialog" class="nt-form"><h2>Unlock with your fingerprint?</h2>
      <p>Next time, open DevHub with a touch instead of typing your password. DevHub opens from the tasks saved on this phone, then connects to the server.</p>
      <p class="hint" id="boMsg" role="status"></p>
      <footer class="nt-foot"><button value="close" id="boNo">Not now</button><button type="button" class="primary" id="boYes">Turn on</button></footer></form>`;
    document.body.appendChild(o); o.showModal();
    o.addEventListener('close', () => o.remove());
    o.querySelector('#boYes').onclick = async () => { const r = await enable(); if (r.ok) { o.close(); d.toast('Fingerprint unlock is on'); } else o.querySelector('#boMsg').textContent = r.msg; };
  }

  /* ---------------- Account page panel ---------------- */
  function panelHtml() {
    if (!supported()) return '';
    const on = enabled(), o = opts();
    return `<section class="panel" id="bioPanel"><h2>Fingerprint unlock</h2>
      <p class="hint">${on ? 'On. DevHub asks for your fingerprint to open. Your sign-in is kept in the phone\'s secure Keystore, not in the app\'s normal storage.' : 'Off. Open DevHub with your fingerprint instead of typing your password.'} The server is only contacted after you unlock.</p>
      ${on ? `<label for="bioAfter">Lock again after I leave the app</label><select id="bioAfter">${[['now', 'Immediately'], ['1', 'After 1 minute'], ['5', 'After 5 minutes'], ['never', 'Only when the app restarts']].map(([k, v]) => `<option value="${k}" ${o.after === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      <div class="row"><button class="${on ? '' : 'primary'}" id="bioToggle">${on ? 'Turn off' : 'Turn on fingerprint unlock'}</button>${on ? '<button id="bioLockNow">Lock now</button>' : ''}</div>
      <p class="hint" id="bioMsg" role="status"></p></section>`;
  }
  function wirePanel() {
    const p = document.getElementById('bioPanel'); if (!p) return;
    const redraw = msg => { p.outerHTML = panelHtml(); wirePanel(); if (msg) { const m = document.getElementById('bioMsg'); if (m) m.textContent = msg; } };
    p.querySelector('#bioToggle').onclick = async () => {
      if (enabled()) { await disable(); redraw('Fingerprint unlock is off. You stay signed in.'); }
      else { const r = await enable(); redraw(r.ok ? 'Fingerprint unlock is on.' : r.msg); }
    };
    const l = p.querySelector('#bioLockNow'); if (l) l.onclick = lock;
    const a = p.querySelector('#bioAfter'); if (a) a.onchange = () => wr(OPTS, { ...opts(), after: a.value });
  }

  window.DHBio = { supported, enabled, locked, lock, offer, refresh, forget, panelHtml, wirePanel };
})();
