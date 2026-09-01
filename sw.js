/* Service Worker：缓存应用外壳，实现离线可用。改动代码后需要更新 CACHE_VERSION。 */
'use strict';

const CACHE_VERSION = 't0ledger-v16';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/fees.js',
  './js/match.js',
  './js/store.js',
  './js/import.js',
  './js/app.js',
  './vendor/xlsx.full.min.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './data/seed.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 网络优先、失败回退缓存：保证有网时总能拿到最新版本，无网时离线可用 */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
