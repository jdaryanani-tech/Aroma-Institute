/* Admin shell is deliberately network-only: never cache credentials, APIs, or prospect data. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch {}
    const id = Number.isSafeInteger(data.notificationId) ? data.notificationId : null;
    await self.registration.showNotification("Aroma Institute · Calendar", {
      body: "You have a schedule update. Open the app to view details.",
      tag: id ? `aichm-calendar-${id}` : "aichm-calendar-update",
      data: { notificationId: id, url: data.url },
      renotify: false,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    let target = new URL("/admin/calendar", self.location.origin);
    try {
      const candidate = new URL(event.notification.data?.url || "/admin/calendar", self.location.origin);
      if (candidate.origin === self.location.origin &&
          (candidate.pathname === "/admin" || candidate.pathname.startsWith("/admin/"))) target = candidate;
    } catch {}
    const notificationId = event.notification.data?.notificationId;
    if (Number.isSafeInteger(notificationId)) target.searchParams.set("notificationId", String(notificationId));
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if (!new URL(client.url).pathname.startsWith("/admin")) continue;
      if ("navigate" in client) await client.navigate(target.href);
      await client.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
