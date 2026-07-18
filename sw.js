const CACHE = 'daily-b2c-v10';
const SHELL = [
  '/daily-ops-webapp/',
  '/daily-ops-webapp/index.html',
  '/daily-ops-webapp/manifest.json',
  '/daily-ops-webapp/icons/icon-192.png',
  '/daily-ops-webapp/icons/icon-512.png'
];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Activate — remove old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — cache-first for shell, network-first for API calls
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for Google Apps Script API calls
  if (url.hostname.includes('script.google.com')) {
    return; // let browser handle normally
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cache same-origin GET responses
        if (res.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback for navigation
        if (e.request.mode === 'navigate') {
          return caches.match('/daily-ops-webapp/index.html');
        }
      });
    })
  );
});
