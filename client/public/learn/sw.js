const CACHE_NAME = "aroma-leap-portal-v1";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(keys =>
        Promise.all(keys.filter(key => key.startsWith("aroma-leap-portal-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))),
      ),
    ]),
  );
});

// Keep the authenticated portal network-only; do not cache account or course data.
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
