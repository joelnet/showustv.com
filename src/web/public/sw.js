// Minimal service worker: exists so browsers treat the app as installable.
// Deliberately NO caching — every request (including /api/* and auth
// cookies) goes straight to the network, exactly like the plain site.
// Offline support is a separate issue (#8); when that lands this file gets
// replaced, and the skipWaiting/claim below make sure updates roll out.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A fetch handler is what older Chromium installability heuristics look
// for. Not calling event.respondWith() keeps the browser's default
// network behavior for every request.
self.addEventListener("fetch", () => {});
