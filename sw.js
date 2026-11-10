'use strict';

const CACHE = 'videoteca-v3';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  SUPABASE_LIB,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // La librería tiene versión fija: se sirve desde la caché.
  if (request.url === SUPABASE_LIB) {
    event.respondWith(caches.match(SUPABASE_LIB).then((cached) => cached || fetch(request)));
    return;
  }

  // Las llamadas a Supabase y a otros sitios no pasan por aquí.
  if (new URL(request.url).origin !== location.origin) return;

  // Archivos de la app: red primero para recibir actualizaciones; caché si no hay conexión.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true })) || caches.match('index.html')),
  );
});
