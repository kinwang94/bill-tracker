'use strict';

const VERSION = 'bt-v23';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.host === 'api.github.com') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Shell (HTML/JS/CSS/manifest) → network-first，新版立刻生效；離線時 fallback cache
  const isShell = /\.(html|js|css)$|\/$|manifest\.json$/.test(url.pathname);
  if (isShell) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(hit => hit || caches.match('./index.html'))
      )
    );
    return;
  }

  // 圖檔/字型等靜態資源 → cache-first（穩定，少變動）
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
