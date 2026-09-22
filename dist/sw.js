/* Service worker of the hosted copy: keeps every app file so the unit opens and runs without a connection (in a car,
   for instance). Generated into dist/sw.js by tools/build_web.py, which fills in the version and the file list. */
const VERSION = '11a8bbf70b';
const CACHE = 'vfd-spectrum-' + VERSION;
const FILES = [
  "./",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "index.html",
  "js/audio-engine.js",
  "js/main.js",
  "js/settings.js",
  "js/spectrum-model.js",
  "js/tags.js",
  "js/vfd-renderer.js",
  "manifest.webmanifest",
  "style.css"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vfd-spectrum-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const home = await cache.match('index.html');
        if (home) return home;
      }
      try {
        return await fetch(req);
      } catch (e) {
        return Response.error();
      }
    })
  );
});
