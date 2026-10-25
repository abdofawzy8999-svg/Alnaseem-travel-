/* Service worker: background push notifications + light offline shell */
importScripts("./config.js");
const V = self.NASEEM.sdk;
importScripts(`https://www.gstatic.com/firebasejs/${V}/firebase-app-compat.js`,
              `https://www.gstatic.com/firebasejs/${V}/firebase-messaging-compat.js`);
firebase.initializeApp(self.NASEEM.firebase);
const messaging = firebase.messaging();

// Data-only fallback (the notifier sends a "notification" block, which the SDK shows itself)
messaging.onBackgroundMessage(payload => {
  if (payload.notification) return;
  const d = payload.data || {};
  self.registration.showNotification(d.title || "النسيم: رسايل للعملاء", {
    body: d.body || "", icon: "./icon-192.png", badge: "./badge.png", tag: "naseem-due",
    renotify: true, dir: "rtl", lang: "ar", data: { link: d.link || "./" }
  });
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const link = (e.notification.data && (e.notification.data.link || (e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link))) || "./";
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { c.navigate && c.navigate(link).catch(() => {}); return c.focus(); } }
    return clients.openWindow(link);
  })());
});

const SHELL = "naseem-shell-v4";
const FILES = ["./", "./index.html", "./app.js", "./config.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).catch(() => {})); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  // network first, cache as fallback so updates show up immediately
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const cp = r.clone(); caches.open(SHELL).then(c => c.put(e.request, cp)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
