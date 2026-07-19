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
// There is no build-time precache manifest: install fetches "/" and caches
// whatever assets that HTML references; later builds are picked up by the
// runtime network-first navigation handler. Caches are capped, trimmed
// oldest-first.
//
// New-version detection (issue #172): the build stamps BUILD below with a
// hash of the built app (vite.config.ts), so every deploy changes sw.js and
// the browser installs the update. Install no longer skipWaiting()s — the
// fresh worker parks in `waiting`, the page shows an update toast
// (src/web/pwa.ts), and only the user's click posts SKIP_WAITING to promote
// it, after which the page reloads once on controllerchange.
//
// Mutations (non-GET) are never cached or intercepted — the app itself
// queues offline mutations in IndexedDB (src/web/offline.ts) and replays
// them when connectivity returns.
//
// The app also warms these caches proactively (src/web/precache.ts): when
// Watch Next loads, it fills any missing or stale Continue Watching detail
// payloads and hero art through this worker (issue #139), and after sign-in
// a background pass warms the user's entire library — index payloads, every
// show/movie detail, and their posters (issue #183) — so the whole library
// browses offline. Both passes skip whatever Cache Storage already holds
// fresh, so a warm client re-fetches nothing on reload. Comments are deliberately never precached (space); they
// are only readable offline when normal browsing already cached them.

// Replaced at build time (sw-build-id plugin, vite.config.ts) with a hash of
// the built client output, which changes whenever a deploy ships different
// client bytes. Unused at runtime on purpose: its only job is to make sw.js
// bytes differ between deploys, which is what makes the browser fetch and
// install the new worker. Deliberately NOT part of the cache names below —
// runtime caches stay valid across deploys.
const BUILD = "__BUILD_ID__";

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
  "/icons/badge-96.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

// Caps sized for a whole library offline (issue #183): the precache pass is
// itself bounded (500 titles), leaving api headroom for indexes, comment
// threads, and everything runtime browsing adds. Rough worst case ~30MB of
// JSON + ~20MB of posters — well inside Cache Storage quotas. Oldest-first
// trim still bounds both.
const MAX_STATIC = 80;
const MAX_API = 700;
const MAX_IMG = 700;

self.addEventListener("install", (event) => {
  // No skipWaiting here (issue #172): an updated worker parks in `waiting`
  // until the page posts SKIP_WAITING (the user pressed Update in the toast)
  // or every tab closes. A first-ever install has no predecessor, so it
  // still activates immediately and clients.claim() takes the open page.
  event.waitUntil(precache());
});

// The page posts this when the user accepts the update toast (issue #172):
// promote the waiting worker now. Activation fires controllerchange in every
// open tab; the one that asked reloads itself into the new version.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  // Capability handshake (issue #183): the page asks the ACTIVE worker for
  // its cache caps before running the full-library precache. An older worker
  // (predating this message) never answers, so the pass skips instead of
  // churning a smaller-capped cache — the parked update activates once every
  // tab closes, and the next launch warms for real.
  if (event.data && event.data.type === "GET_CAPS" && event.ports[0]) {
    event.ports[0].postMessage({ maxApi: MAX_API, maxImg: MAX_IMG });
  }
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
    // Never cached — but any identity change must empty the API cache.
    // Sign-out: the next visitor on this browser must not replay this
    // user's data. Sign-in/register (issue #159): the new session must not
    // inherit responses cached before it — another account's payloads, or
    // the anonymous title payloads (user: null), which would render a
    // signed-in detail page with no state on an offline fallback.
    // Finish Signup (issue #160): the cached /api/auth/me still says
    // onboarded: false, which an offline boot would replay and bounce an
    // already-onboarded user back to /welcome.
    const identityChange =
      url.pathname === "/api/auth/logout" ||
      url.pathname === "/api/auth/login" ||
      url.pathname === "/api/auth/register" ||
      url.pathname === "/api/auth/onboarding";
    if (identityChange) {
      event.respondWith(
        (async () => {
          const res = await fetch(req);
          if (res.ok) {
            await caches.delete(API_CACHE);
            identityChangedAt = Date.now();
          }
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

// When the signed-in identity last changed (login/logout/register/onboarding
// above, or a 401 below) — the moment the api cache was wiped. Any GET that
// was already in flight across that wipe belongs to the PREVIOUS session and
// must not be re-inserted after it (issue #183: the full-library warm keeps
// a request in flight for most of a long pass, so this race is real, and a
// stale personal payload would then serve the next account's offline reads).
// In-memory on purpose: an SW restart can't straddle an in-flight request.
let identityChangedAt = 0;

async function apiNetworkFirst(req) {
  const cache = await caches.open(API_CACHE);
  const started = Date.now();
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
    if (started <= identityChangedAt) {
      // Fetched under the previous identity (see identityChangedAt above) —
      // return it to the page that asked, but never store it.
      return res;
    }
    // no-store marks a response the server considers too personal to persist
    // (e.g. the owner's preview of their private profile on the public,
    // viewer-varying /api/public/profile URL) — honor it, and drop any older
    // cached copy of the same URL so a replay can't resurrect it either.
    if (/\bno-store\b/.test(res.headers.get("cache-control") ?? "")) {
      await cache.delete(req.url);
    } else {
      await cache.put(req.url, res.clone());
      trim(cache, MAX_API);
    }
  } else if (res.status === 401) {
    // Session over — drop the personal cache so nothing leaks after sign-out.
    await caches.delete(API_CACHE);
    identityChangedAt = Date.now();
  }
  return res;
}

async function shellNetworkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    // Every route serves the same SPA HTML — except the pages whose <head>
    // the Worker rewrites with per-page social meta: title pages (issue #211)
    // and, under /u/, public profiles (issue #219) and shared lists (issue
    // #335). Skip those so one show's/profile's/list's tags can't become the
    // offline boot shell for every route; install() already caches the generic
    // "/" copy. (/u/ sub-paths the Worker leaves untouched serve that same
    // generic shell, so skipping them here changes nothing but the source.)
    const rewritten = /^\/(show|movie|episode|u)\//.test(new URL(req.url).pathname);
    if (res.ok && !rewritten) await cache.put(SHELL_KEY, res.clone());
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
// body, url, tag, unread }. We subscribed with userVisibleOnly, so every
// push MUST show a notification — Chrome shows a generic "site updated in
// the background" (and eventually revokes push) otherwise. Same `tag`
// replaces the previous notification instead of stacking.
//
// `unread` is the recipient's exact unread count at send time; it drives the
// installed PWA's app-icon badge (issue #142) so the count is right even
// when no page is alive. While a page IS alive, its unread store applies the
// same number on every refresh (src/web/notifications.ts), so the two
// writers converge instead of fighting.

self.addEventListener("push", (event) => {
  let raw = {};
  try {
    raw = event.data ? event.data.json() : {};
  } catch {
    // non-JSON payload (test push) — fall through to the defaults
  }
  // The Worker sends the Declarative Web Push envelope ({ web_push: 8030,
  // notification: {...} }): Safari 18.4+ renders it without waking this
  // worker; Chrome/Firefox deliver the whole JSON here instead. The flat
  // fields are the legacy shape — pushes from a Worker deployed before the
  // envelope, read by this handler until every sender is updated.
  const n = raw.web_push === 8030 && raw.notification ? raw.notification : raw;
  // Clamp before display: the payload is ours end-to-end, but a decrypted
  // blob is still remote input to the lock screen — cap lengths and types.
  const str = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  const title = str(n.title, 120) || "Show Us TV";
  const body = str(n.body, 240) || "";
  const tag = str(n.tag, 64);
  const url = str(n.navigate, 2048) || str(raw.url, 2048) || "/notifications";
  // app_badge is stringified on the declarative path (WebKit payload format);
  // `unread` is the legacy number. Either way: a non-negative integer or bust.
  const count = n.app_badge !== undefined ? Number(n.app_badge) : raw.unread;
  const unread = Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  // Push-delivery diagnostics: for admin test pushes only (the `test-` tag,
  // worker lib/notifications.ts), report each stage back to the server so
  // Workers Logs shows how far a push got on THIS device — the admin test
  // button's server-side receipt. The /api/push-diag route deliberately
  // doesn't exist: the 404'd invocation log line (URL + user-agent, carrying
  // stage and the SW's own Notification.permission) IS the signal. Real
  // users' pushes never beacon, and requests made from the SW bypass its own
  // fetch handler, so nothing is cached or intercepted. Proven in the
  // 2026-07-18 hunt: "received"+"shown" with nothing on screen pinned a
  // Brave-bound WebAPK swallowing Chrome's display at the Android channel
  // layer — unobservable from the server side any other way.
  const diag = (stage) =>
    tag && tag.startsWith("test-")
      ? fetch(
          "/api/push-diag?stage=" +
            encodeURIComponent(stage) +
            "&perm=" +
            encodeURIComponent((self.Notification && Notification.permission) || "unknown")
        ).catch(() => {})
      : Promise.resolve();
  event.waitUntil(
    (async () => {
      await diag("received");
      // Badge first, notification second — but the badge is best-effort
      // (Badging API missing, PWA not installed, promise rejection) and must
      // never block the mandatory showNotification.
      if (unread !== undefined && "setAppBadge" in navigator) {
        try {
          if (unread > 0) await navigator.setAppBadge(unread);
          else await navigator.clearAppBadge();
        } catch {
          // no badge on this platform — the notification itself still lands
        }
      }
      try {
        await self.registration.showNotification(title, {
          body,
          icon: "/icons/icon-192.png",
          // Monochrome white-on-transparent glyph: Android status-bar badges
          // keep only the alpha channel, so the full-color app icon renders as
          // a formless blob there.
          badge: "/icons/badge-96.png",
          tag: tag || undefined,
          timestamp: typeof n.timestamp === "number" ? n.timestamp : Date.now(),
          data: { url },
        });
      } catch (e) {
        // Diagnostics only — see diag() above. Rethrown: a swallowed
        // showNotification failure would break the userVisibleOnly contract.
        await diag("show-failed-" + ((e && e.name) || "Error"));
        throw e;
      }
      await diag("shown");
      // Tell open pages now — the bell otherwise waits for its next poll
      // (up to 90s) while the OS notification is already on screen.
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const page of pages) page.postMessage({ type: "PUSH_RECEIVED", unread: unread !== undefined ? unread : null });
    })()
  );
});

// The push service can rotate or expire a subscription while no page is open
// (key rotation, permission flips, service-side expiry). Without this
// handler the device silently stops receiving pushes and the server row goes
// stale until a send gets a 404/410 and is pruned — register the replacement
// with the server instead. Auth rides on the session cookie.
const PUSH_SUBSCRIPTION_SYNC_TAG = "push-subscription-sync";

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      // Some browsers hand over the replacement subscription on the event
      // itself; only re-subscribe when they don't (Chrome).
      let sub = event.newSubscription || null;
      if (!sub) {
        try {
          let key = (event.oldSubscription && event.oldSubscription.options.applicationServerKey) || null;
          if (!key) {
            const res = await fetch("/api/notifications/prefs", { credentials: "same-origin" });
            if (!res.ok) return;
            const prefs = await res.json();
            if (!prefs.pushPublicKey) return;
            key = urlBase64ToUint8Array(prefs.pushPublicKey);
          }
          sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch {
          return; // no permission or no key to subscribe with — nothing to register
        }
      }
      try {
        await registerPushSubscriptionWithServer(sub);
      } catch {
        // The replacement is still valid browser-side. Keep it through an
        // offline or transient server failure and let Background Sync retry it.
        // Destroying it here would turn a recoverable sync miss into a false
        // "push off" state. Background Sync is Chromium-only and best-effort;
        // keeping the subscription is still the safer fallback without it.
        if ("sync" in self.registration)
          await self.registration.sync.register(PUSH_SUBSCRIPTION_SYNC_TAG).catch(() => {});
      }
    })()
  );
});

// A one-off Background Sync retries a rotated subscription that could not be
// registered while the device was offline. Rejecting the event's promise asks
// Chromium to retry later with its normal backoff.
self.addEventListener("sync", (event) => {
  if (event.tag !== PUSH_SUBSCRIPTION_SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) await registerPushSubscriptionWithServer(sub);
    })()
  );
});

async function registerPushSubscriptionWithServer(sub) {
  const res = await fetch("/api/notifications/push/subscribe", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Mirrors urlBase64ToUint8Array in src/web/notifications.ts — this file is
// standalone plain JS (no bundling), so it keeps its own copy.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

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
      const same = wins.filter((c) => c.url.startsWith(self.location.origin) && "focus" in c);
      // Prefer the window the user is actually in, then a visible one, then
      // any — navigating a background tab in some other window while the
      // active app sits untouched reads as a dead click.
      const target = same.find((c) => c.focused) || same.find((c) => c.visibilityState === "visible") || same[0];
      if (target) {
        if ("navigate" in target) await target.navigate(url).catch(() => {});
        return target.focus();
      }
      return self.clients.openWindow(url);
    })()
  );
});
