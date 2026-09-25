// DevHub service worker: offline app shell, never caches GitHub API calls.
const CACHE = 'devhub-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'seed/links.json', 'config.js', 'tasks.js', 'worker.js',
  'vendor/papaparse.min.js', 'vendor/xlsx.full.min.js', 'vendor/fxp.min.js', 'vendor/js-yaml.min.js', 'vendor/beautifier.min.js', 'vendor/sql-formatter.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Account API calls always go to the network, never the cache
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== location.origin && !/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return;
  // Stale-while-revalidate for app files and fonts
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: url.origin === location.origin });
    const network = fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached || (e.request.mode === 'navigate' ? cache.match('index.html') : Response.error()));
    return cached || network;
  }));
});
