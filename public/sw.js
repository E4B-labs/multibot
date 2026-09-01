const CACHE = "multibot-shell-v6";
const SHELL = ["/", "/index.html", "/app-icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

// Kopia do cache'a MUSI powstać, zanim przeglądarka zacznie czytać oryginał.
// `caches.open` jest asynchroniczne, więc `response.clone()` wywołane w jego
// `then` trafiało już na zużyte ciało — „Failed to execute 'clone' on
// 'Response': Response body is already used". Powłoka w cache'u zostawała
// wtedy ta z pierwszej instalacji, czyli z czasów zepsutej paczki, i przy
// słabej sieci wracał z niej czarny ekran.
const cachePut = (key, response) => {
  if (!response.ok) return response;
  const copy = response.clone();
  void caches.open(CACHE).then((cache) => cache.put(key, copy));
  return response;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Navigation is network-first so a deployed bundle is visible immediately.
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(
      fetch(request)
        .then((response) => cachePut("/index.html", response))
        .catch(() => caches.match("/index.html")),
    );
    return;
  }
  // Hashed assets may stay cache-first. User data always stays network-only.
  const cacheable = url.pathname.startsWith("/assets/") || url.pathname === "/app-icon.png";
  if (!cacheable) return;
  // Bez awaryjnego `/index.html`: paczka HTML-a oddana zamiast skryptu wywala
  // się w parserze jako SyntaxError. Nieudane pobranie ma zostać nieudane.
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => cachePut(request, response))));
});
