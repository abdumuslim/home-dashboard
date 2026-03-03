self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};

  const tag = data.type === "sensor"
    ? "sensor-" + (data.metric ?? "unknown")
    : data.prayer ?? "prayer";

  event.waitUntil(
    self.registration.showNotification(data.title ?? "Alert", {
      body: data.body ?? "",
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag,
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
