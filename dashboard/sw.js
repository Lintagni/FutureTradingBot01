const CACHE = 'futures-bot-v3';
const PRECACHE = ['/login.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({type:'window',includeUncontrolled:true})
        .then(clients => clients.forEach(c => c.postMessage({type:'SW_UPDATED'}))))
  );
});

// Network-first: API, root SPA, and all JS/JSX app files (always fresh after deploy)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const networkFirst =
    url.pathname.startsWith('/api/') ||
    url.pathname === '/' ||
    url.pathname.endsWith('.jsx') ||
    url.pathname.endsWith('.js') && !url.pathname.includes('cdn') && !url.hostname.includes('unpkg') && !url.hostname.includes('jsdelivr');

  if (networkFirst) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }))
  );
});
