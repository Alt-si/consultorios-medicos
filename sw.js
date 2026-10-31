// Service worker: permite instalar la app y abrirla aunque falle la conexión.
// Cambiá VERSION cuando subas cambios grandes para forzar la actualización.
const VERSION = "turnos-v10";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./config.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/api/")) return;              // turnos y datos: siempre por internet
  // Páginas: primero internet (para ver siempre lo último); sin conexión, la copia guardada.
  if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("config.js")){
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, {ignoreSearch: true}).then(r => r || caches.match("./index.html"))));
    return;
  }
  // Íconos: primero la copia guardada.
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
});
