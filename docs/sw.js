// Service worker: makes the app open offline. The app shell is served from cache and refreshed
// in the background; calls to the Google backend are never cached.
// Bump VERSION whenever files in docs/ change, so devices pick up the new version.
const VERSION = 'v3';
const CACHE = `ht-${VERSION}`;
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/app.js', 'js/store.js', 'js/dates.js', 'js/demo.js', 'js/timer.js', 'js/planner.js', 'js/inbox.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  // stale-while-revalidate for the app shell and fonts
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const network = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
