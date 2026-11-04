// Rende l'app apribile senza rete. I file dell'app si aggiornano in background;
// motore e modello, una volta scaricati, restano nel telefono.
const VERSION = 'analisi-corsa-1';
const ENGINE = 'analisi-corsa-engine-0.10.14';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'metrics.js', 'sim.js', 'engine.js', 'store.js', 'report.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const ENGINE_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== ENGINE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (ENGINE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(ENGINE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
  } else if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    }));
  }
});
