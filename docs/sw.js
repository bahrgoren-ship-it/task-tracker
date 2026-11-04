// Service worker: makes the app open offline. Online, the app is always loaded fresh from the network (so updates
// show up at once); offline it comes from the cache. Calls to the Google backend are never cached.
// Bump VERSION whenever files in docs/ change, so devices pick up the new version.
const VERSION = 'v10';
const CACHE = `ht-${VERSION}`;
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/app.js', 'js/store.js', 'js/dates.js', 'js/demo.js', 'js/timer.js', 'js/planner.js', 'js/inbox.js', 'js/notices.js', 'js/suggestions.js', 'js/categories.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' = skip the browser's HTTP cache (GitHub Pages caches files for 10 min), so a new version
  // never stores old files
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => { if (r.ok) return c.put(u, r); }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ht-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (url.origin === location.origin) {
    // the app itself: network first (always the newest version when online), cache when offline / very slow
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const network = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      const timeout = new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch { /* offline */ }
      return (await cache.match(req, { ignoreSearch: true })) || network;
    }));
    return;
  }
  // fonts: stale-while-revalidate
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
