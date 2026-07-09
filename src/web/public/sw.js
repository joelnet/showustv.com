// Offline support (issue #8). Three runtime caches, all versioned so a
// future VERSION bump abandons old data wholesale on activate:
//   static — the SPA shell + hashed /assets/* (content-addressed, safe to
//            serve cache-first forever), manifest, icons, web fonts.
//   api    — GET /api/* responses, network-first; when the network is gone
//            the last good copy is served with an x-sw-fallback header so
//            the app knows it is looking at stale data.
//   img    — TMDB posters/stills, cache-first. This is browser-side caching
//            only (like the HTTP cache) — nothing is proxied or stored
//            server-side, in line with the TMDB hotlinking plan.
//
// sw.js itself is static while asset names change per build, so there is no
// build-time precache manifest: install fetches "/" and caches whatever
// assets that HTML references; later builds are picked up by the runtime
// network-first navigation handler. Caches are capped, trimmed oldest-first.
//
// Mutations (non-GET) are never cached or intercepted — the app itself
// queues offline mutations in IndexedDB (src/web/offline.ts) and replays
// them when connectivity returns.
//
// The app also warms these caches proactively: when Watch Next loads, it
// fetches each Continue Watching show's detail payload and hero art through
// this worker (src/web/precache.ts, issue #139) so those shows open offline.

const VERSION = "v1";
const STATIC_CACHE = `static-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const IMG_CACHE = `img-${VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, API_CACHE, IMG_CACHE];

// Synthetic cache key for the HTML shell: every navigation serves the same
// SPA document, so one entry covers every route.
const SHELL_KEY = "/app-shell";
const STATIC_EXTRAS = [
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

const MAX_STATIC = 80;
const MAX_API = 100;
const MAX_IMG = 200;

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (!KNOWN_CACHES.includes(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

// First load: the page's own requests happened before this worker took
// control, so explicitly fetch the shell and everything it references —
// after install an offline reload can boot the app.
async function precache() {
  try {
    const cache = await caches.open(STATIC_CACHE);
    const res = await fetch("/", { cache: "no-cache" });
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put(SHELL_KEY, res);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.all(
      [...assets, ...STATIC_EXTRAS].map(async (url) => {
        try {
          const r = await fetch(url, { cache: "no-cache" });
          if (r.ok) await cache.put(url, r);
        } catch {
          // picked up by runtime caching once there's a network
        }
      })
    );
  } catch {
    // offline install — runtime caching fills in later; never block install
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") {
    // Never cached — but signing out must also empty the personal API cache.
    if (url.pathname === "/api/auth/logout") {
      event.respondWith(
        (async () => {
          const res = await fetch(req);
          if (res.ok) await caches.delete(API_CACHE);
          return res;
        })()
      );
    }
    return; // default network behavior for all other mutations
  }

  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) {
      // Auth endpoints are never cached — except GET /api/auth/me, the
      // "who am I" the app needs to boot while offline. A 401 anywhere (or
      // logout above) wipes the whole API cache, so nothing personal
      // survives the end of a session.
      if (url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/me") return;
      // Admin responses (other users' audit trails) must never persist in
      // Cache Storage, and an offline replay would dodge the server's
      // admin-view audit row — straight to the network, no cache.
      if (url.pathname.startsWith("/api/admin/")) return;
      event.respondWith(apiNetworkFirst(req));
    } else if (req.mode === "navigate") {
      event.respondWith(shellNetworkFirst(req));
    } else if (url.pathname.startsWith("/assets/")) {
      event.respondWith(cacheFirst(req, STATIC_CACHE, MAX_STATIC)); // content-hashed
    } else {
      event.respondWith(networkFirst(req, STATIC_CACHE, MAX_STATIC)); // manifest, icons
    }
    return;
  }

  if (url.hostname === "image.tmdb.org") {
    event.respondWith(cacheFirst(req, IMG_CACHE, MAX_IMG));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, STATIC_CACHE, MAX_STATIC));
  }
});

async function apiNetworkFirst(req) {
  const cache = await caches.open(API_CACHE);
  let res;
  try {
    res = await fetch(req);
  } catch {
    const hit = await cache.match(req.url);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-sw-fallback", "1");
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
    return new Response(JSON.stringify({ error: "You're offline" }), {
      status: 503,
      headers: { "content-type": "application/json", "x-sw-fallback": "1" },
    });
  }
  if (res.ok) {
    await cache.put(req.url, res.clone());
    trim(cache, MAX_API);
  } else if (res.status === 401) {
    // Session over — drop the personal cache so nothing leaks after sign-out.
    await caches.delete(API_CACHE);
  }
  return res;
}

async function shellNetworkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    // Every route serves the same SPA HTML — keep the freshest copy as the
    // offline boot shell.
    if (res.ok) await cache.put(SHELL_KEY, res.clone());
    return res;
  } catch {
    const hit = await cache.match(SHELL_KEY);
    return (
      hit ??
      new Response("You're offline and the app isn't cached yet.", {
        status: 503,
        headers: { "content-type": "text/plain" },
      })
    );
  }
}

async function networkFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req.url, res.clone());
      trim(cache, max);
    }
    return res;
  } catch {
    const hit = await cache.match(req.url);
    return hit ?? new Response("", { status: 503 });
  }
}

async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque (no-cors images/fonts) responses report status 0 but are cacheable.
  if (res.ok || res.type === "opaque") {
    await cache.put(req.url, res.clone());
    trim(cache, max);
  }
  return res;
}

// Cap a cache, deleting oldest-first. Cache keys come back in insertion
// order and a re-put moves an entry to the back, so network-first entries
// refresh their position; cache-first entries (hashed assets, images) age
// out only under pressure from newer ones. Fire-and-forget.
function trim(cache, max) {
  cache
    .keys()
    .then(async (keys) => {
      for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
    })
    .catch(() => {});
}

// ---------- Web Push (issue #129) ----------
// The Worker sends JSON payloads (see src/worker/lib/push.ts): { title,
// body, url, tag }. We subscribed with userVisibleOnly, so every push MUST
// show a notification — Chrome shows a generic "site updated in the
// background" (and eventually revokes push) otherwise. Same `tag` replaces
// the previous notification instead of stacking.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload (test push) — fall through to the defaults
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Show Us TV", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/notifications" },
    })
  );
});

// Clicking the notification focuses an open app window (navigating it to the
// target) or opens a new one. The payload URL is normalized to this origin —
// our Worker only ever sends same-origin paths, so anything else is a
// malformed or forged payload and falls back to the notifications page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = "/notifications";
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || url, self.location.origin);
    if (u.origin === self.location.origin) url = u.href;
  } catch {
    // keep the fallback
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of wins) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          if ("navigate" in client) await client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
