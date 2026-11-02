// OmniTerm PWA Service Worker for standalone installability
const CACHE_NAME = 'omniterm-sw-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // Never intercept API routes or terminal iframe/websocket paths
  const url = event.request.url;
  if (url.includes('/api/') || url.includes('/t/')) {
    return;
  }

  // Network-first with cache fallback for static app assets
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
