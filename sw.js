'use strict';

const CACHE = 'videoteca-v6';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
const SWAL_LIB = 'https://cdn.jsdelivr.net/npm/sweetalert2@11.14.5/dist/sweetalert2.all.min.js';
const PINNED = [SUPABASE_LIB, SWAL_LIB];
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
  ...PINNED,
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

  // Las librerías tienen versión fija: se sirven desde la caché.
  if (PINNED.includes(request.url)) {
    event.respondWith(caches.match(request.url).then((cached) => cached || fetch(request)));
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
