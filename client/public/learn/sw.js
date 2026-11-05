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

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch {}
    const id = Number.isSafeInteger(data.notificationId) ? data.notificationId : null;
    await self.registration.showNotification("Aroma Institute · Learning", {
      body: "You have a timetable update. Open the portal to view details.",
      tag: id ? `aroma-leap-calendar-${id}` : "aroma-leap-calendar-update",
      data: { notificationId: id, url: data.url },
      renotify: false,
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL("/learn/calendar", self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || "/learn/calendar", self.location.origin);
      if (candidate.origin === self.location.origin &&
          (candidate.pathname === "/learn" || candidate.pathname.startsWith("/learn/"))) target = candidate;
    } catch {}
    const notificationId = event.notification.data?.notificationId;
    if (Number.isSafeInteger(notificationId)) target.searchParams.set("notificationId", String(notificationId));
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if (!new URL(client.url).pathname.startsWith("/learn")) continue;
      if ("navigate" in client) await client.navigate(target.href);
      await client.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
