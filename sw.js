// Toolbox+ service worker: offline app shell, never caches GitHub API calls.
const CACHE = 'devhub-v44';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'favicon.ico', 'icons/icon.svg', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'seed/links.json', 'config.js', 'tasks.js', 'notify.js', 'biolock.js', 'offline-db.js', 'adapter.js', 'worker.js', 'migrate.js', 'sap-cva.js', 'sap-cva-core.js', 'sap-delta.js', 'insurance.js', 'home.js', 'remediation-planner.html', 'remediation-planner.js', 'vendor/sql-wasm.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/sql-wasm.wasm',
  'vendor/papaparse.min.js', 'vendor/xlsx.full.min.js', 'vendor/fxp.min.js', 'vendor/js-yaml.min.js', 'vendor/beautifier.min.js', 'vendor/sql-formatter.min.js', 'vendor/xlsx-style.min.js'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so the new version's files are stored, not stale copies
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k !== CACHE);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
// Is this response really Toolbox+ (and not a hosting provider's wake-up / error page)?
async function isOurs(req, res) {
  if (!res || !res.ok || res.type === 'opaqueredirect') return false;
  const ct = res.headers.get('content-type') || '', html = /text\/html/i.test(ct);
  const wantsHtml = req.mode === 'navigate' || /(\.html|\/)$/.test(new URL(req.url).pathname);
  if (!wantsHtml) return !html;   // scripts, styles and data never come back as an HTML page
  if (!html) return false;
  const t = await res.clone().text();
  return t.includes('<main id="view"') || t.includes('remediation-planner.js');
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Account API calls always go to the network, never the cache
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== location.origin && !/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return;
  // App files (HTML, JS, CSS, JSON, manifest): network first, so a new deploy shows up on the next load; the cache is the offline fallback.
  // Fonts, icons and bundled libraries: cache first (they rarely change), refreshed in the background.
  const appFile = url.origin === location.origin && !/\/(vendor|icons)\//.test(url.pathname) && (e.request.mode === 'navigate' || /\.(html|js|css|json|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/'));
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = () => cache.match(e.request, { ignoreSearch: url.origin === location.origin }).then(r => r || (e.request.mode === 'navigate' ? cache.match('index.html') : undefined));
    if (appFile) {
      // Network first, but never wait on a sleeping host and never show its "starting up" page: if the network is slow (3 s)
      // or answers with something that isn't Toolbox+, the copy on this device is used and the new version is stored for next time.
      const net = fetch(e.request, { cache: 'no-cache' }).then(async res => { if (await isOurs(e.request, res)) { await cache.put(e.request, res.clone()); return res; } return null; }).catch(() => null);
      const have = await cached();
      if (!have) return (await net) || fetch(e.request).catch(() => Response.error());   // first visit: nothing stored yet
      e.waitUntil(net);
      const quick = await Promise.race([net, new Promise(r => setTimeout(() => r(null), 3000))]);
      return quick || have;
    }
    const hit = await cached();
    const network = fetch(e.request).then(res => { if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || network;
  }));
});

// Tapping a notification: focus Toolbox+ if it is open (and open the task), otherwise open it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const taskId = e.notification.data && e.notification.data.taskId, route = e.notification.data && e.notification.data.route, ref = e.notification.data && e.notification.data.ref;
  if (e.action && ref) {   // Snooze button: tell an open Toolbox+, or open it with the action in the address
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => new URL(c.url).origin === location.origin);
      if (open) { open.postMessage({ type: 'notify-action', action: e.action, ref }); return; }
      return self.clients.openWindow('./#' + (route || 'insurance') + '?nact=' + encodeURIComponent(e.action) + '&ref=' + encodeURIComponent(ref));
    }));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === location.origin);
    if (open) { open.postMessage({ type: 'notify-open', taskId, route }); return open.focus(); }
    return self.clients.openWindow(route ? './#' + route : './#tasks' + (taskId ? '?open=' + encodeURIComponent(taskId) : ''));
  }));
});
