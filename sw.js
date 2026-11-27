// Caches the app shell so it opens offline. Recordings live in IndexedDB, not here.
const CACHE = 'sleepmon-v15';
const ASSETS = ['./', 'index.html', 'styles.css', 'version.js', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
// the sound-recognition runtime and model (web version): cached once loaded, so recognition works offline too
const CDN = ['https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@', 'https://storage.googleapis.com/mediapipe-models/'];
const NETWORK_TIMEOUT_MS = 3000; // a slow network (one bar at night) falls back to the cached copy after this

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => url.origin === self.location.origin;
const cacheable = (req, res) => res && res.status === 200 &&
  (res.type === 'basic' || (res.type === 'cors' && CDN.some((p) => req.url.startsWith(p))));

// the cached copy: pages (any query string, e.g. ?source=pwa) fall back to the app shell
async function fromCache(req) {
  const nav = req.mode === 'navigate';
  return (await caches.match(req, { ignoreSearch: nav })) || (nav ? caches.match('index.html') : undefined);
}

// Network first (so updates show up when online), the cache when offline, on errors or after a timeout.
// Only good responses (200) are cached: a 404/503 from a hiccup of the host must not replace a good copy.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!(sameOrigin(url) || CDN.some((p) => req.url.startsWith(p)))) return; // other hosts: not our business
  if (req.headers.has('range')) return; // partial content (media) is never cached

  const net = fetch(req);
  e.waitUntil(net.then(async (res) => {
    if (cacheable(req, res)) await (await caches.open(CACHE)).put(req, res.clone());
  }).catch(() => {}));

  e.respondWith((async () => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS); });
    const viaNet = net.then((res) => (res.ok || res.type === 'opaque' ? res : fromCache(req).then((c) => c || res)),
      () => fromCache(req).then((c) => c || Response.error()));
    // after the timeout the cached copy wins if there is one; otherwise keep waiting for the network
    const viaTimeout = timeout.then(() => fromCache(req)).then((c) => c || viaNet);
    try { return await Promise.race([viaNet, viaTimeout]); } finally { clearTimeout(timer); }
  })());
});
