// Naikkan VERSION setiap kali file shell (index/style/app) diubah
const VERSION = 'sparepart-v3';
const SHELL_CACHE = VERSION + '-shell';
const FONT_CACHE = VERSION + '-fonts';

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/Sparepart%20192%20light.png',
  './assets/Sparepart%20512%20light.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API Apps Script: jangan disentuh SW (cache data diurus app.js)
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return;

  // File milik app sendiri
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req).catch(() => caches.match('./index.html'))
      );
      return;
    }
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Google Fonts
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // Selain itu (foto Drive, gif) biarkan ke browser/network.
  // Foto Drive sengaja tidak di-cache SW karena respons cross-origin (opaque)
  // memakan kuota penyimpanan besar.
});
