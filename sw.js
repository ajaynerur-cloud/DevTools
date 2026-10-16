// DevHub service worker: offline app shell, never caches GitHub API calls.
const CACHE = 'devhub-v31';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'favicon.ico', 'icons/icon.svg', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'seed/links.json', 'config.js', 'tasks.js', 'notify.js', 'biolock.js', 'offline-db.js', 'adapter.js', 'worker.js', 'migrate.js', 'sap-cva.js', 'sap-cva-core.js', 'sap-delta.js', 'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm',
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
      try { const res = await fetch(e.request, { cache: 'no-cache' }); if (res.ok) cache.put(e.request, res.clone()); return res; }
      catch { return (await cached()) || Response.error(); }
    }
    const hit = await cached();
    const network = fetch(e.request).then(res => { if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || network;
  }));
});

// Tapping a notification: focus DevHub if it is open (and open the task), otherwise open it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const taskId = e.notification.data && e.notification.data.taskId;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === location.origin);
    if (open) { open.postMessage({ type: 'notify-open', taskId }); return open.focus(); }
    return self.clients.openWindow('./#tasks' + (taskId ? '?open=' + encodeURIComponent(taskId) : ''));
  }));
});
