const CACHE = "multibot-shell-v2";
const SHELL = ["/", "/index.html", "/app-icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Navigation is network-first so a deployed bundle is visible immediately.
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE).then((cache) => cache.put("/index.html", response.clone()));
      return response;
    }).catch(() => caches.match("/index.html")));
    return;
  }
  // Hashed assets may stay cache-first. User data always stays network-only.
  const cacheable = url.pathname.startsWith("/assets/") || url.pathname === "/app-icon.svg";
  if (!cacheable) return;
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => caches.match("/index.html"))),
  );
});
