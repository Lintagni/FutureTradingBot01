const CACHE = 'futures-bot-v4';
const PRECACHE = ['/login.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // CDN resources are version-pinned — cache-first is safe and fast
  const isCDN = url.hostname.includes('unpkg.com') ||
                url.hostname.includes('jsdelivr.net') ||
                url.hostname.includes('cdn.jsdelivr') ||
                url.hostname.includes('cdnjs.');

  if (isCDN) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // Everything from our own origin: network-first so deploys are always reflected
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
