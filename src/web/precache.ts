// Precache Continue Watching (issue #139).
//
// Offline support (issue #51) caches API responses and images as they're
// fetched, so a show's detail page only works offline if the user happened
// to open it while online. The Continue Watching row is exactly the set
// they're most likely to open, so when /home data arrives we warm the
// service worker's existing runtime caches for each of those shows:
//
//   - the detail payload (GET /api/shows/:id) — flows through the SW's
//     network-first API handler, landing in the api cache. The parsed body is
//     also seeded into the in-memory page cache (hooks.ts, issue #154
//     follow-up) so an ONLINE tap paints the detail page from cache instantly,
//     with no loading skeleton, then refreshes it in the background;
//   - the detail page's hero art (poster + backdrop, the same URLs img.ts
//     builds) — flows through the SW's cache-first image handler.
//
// A later offline tap on a tile then resolves entirely from cache: the SPA
// shell serves the navigation, the cached payload renders the page, and
// watch/favorite actions queue in the offline mutation queue (offline.ts).
//
// Bounds: only the front of the Continue Watching row (MAX_SHOWS), never the
// whole library; each URL re-warms at most once per FRESH_MS per page load
// (the API strategy is network-first, so every warm also refreshes the
// copy); fetches run sequentially so warming never competes with the page
// for bandwidth. The SW's cache caps (MAX_API/MAX_IMG, trimmed oldest-first)
// still bound total storage — nothing here grows a cache unbounded.

import { backdrop, poster } from "./img";
import { cacheGeneration, setCached } from "./hooks";

export interface PrecacheItem {
  kind: "show" | "movie";
  id: number;
  poster: string | null;
  backdrop: string | null;
}

const MAX_SHOWS = 12;
const FRESH_MS = 15 * 60 * 1000;

// URL → when it was last successfully warmed. Module state, so a fresh page
// load warms once more — cheap, and it keeps the cached copies current.
const warmedAt = new Map<string, number>();

const isFresh = (url: string) => {
  const t = warmedAt.get(url);
  return t != null && Date.now() - t < FRESH_MS;
};

// Fetch a URL purely so the service worker caches the response; the body is
// discarded here. Only a real network success marks the URL warm — a cache
// fallback (x-sw-fallback) or an error leaves it unmarked so a later pass
// retries. Returns false when the whole pass should stop: a 401 means the
// session ended (the SW empties its api cache on any 401, by design), so
// every further warm would only repeat the failure. Deliberately NOT routed
// through api.ts — its 401 handling redirects to /login, which a background
// task must never do; the next user action surfaces the expired session.
async function warm(url: string, init?: RequestInit): Promise<boolean> {
  if (isFresh(url)) return true;
  try {
    const res = await fetch(url, { credentials: "same-origin", ...init });
    // Opaque responses (no-cors images) report status 0 but were cached.
    const cached = res.type === "opaque" || (res.ok && !res.headers.has("x-sw-fallback"));
    void res.body?.cancel();
    if (cached) warmedAt.set(url, Date.now());
    return res.status !== 401;
  } catch {
    return true; // transient failure — the offline check in the loop covers a dead network
  }
}

// Like warm(), but the detail payload is also parsed and seeded into the
// in-memory page cache (hooks.ts, issue #154 follow-up) under `key` — the same
// path the detail page reads — so opening this tile renders from cache with no
// loading skeleton. Seeds ONLY a fresh network response: a cache fallback
// (x-sw-fallback) or an error never masquerades as good page data, and the
// detail page's own background refetch refreshes it regardless. Reading the
// body here doesn't affect the SW's own cached copy.
async function warmSeed(url: string, key: string): Promise<boolean> {
  if (isFresh(url)) return true;
  // The account this warm belongs to, captured before the fetch: if a sign-out
  // /sign-in happens while it's in flight, the seed drops itself rather than
  // landing in the next account's cache.
  const gen = cacheGeneration();
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok && !res.headers.has("x-sw-fallback")) {
      try {
        setCached(key, await res.json(), gen);
        warmedAt.set(url, Date.now());
      } catch {
        void res.body?.cancel(); // unparseable — leave it unwarmed for a later pass
      }
    } else {
      void res.body?.cancel();
    }
    return res.status !== 401;
  } catch {
    return true; // transient failure — the offline check in the loop covers a dead network
  }
}

let running = false;
let queued: PrecacheItem[] | null = null; // newest set handed in while a pass was running
let pending: PrecacheItem[] | null = null; // newest set handed in before the SW controlled the page

// Called from Watch Next when /home data arrives. Fire-and-forget.
export function precacheContinueWatching(items: PrecacheItem[]): void {
  // Skipped while offline; when connectivity returns, the revalidation
  // refetch of /home hands us a fresh set anyway.
  if (!("serviceWorker" in navigator) || !navigator.onLine) return;

  if (!navigator.serviceWorker.controller) {
    // First visit: pwa.ts registers the worker on window load, so /home
    // usually arrives before the worker has installed and claimed the page —
    // and an uncontrolled page's fetches would warm nothing. Hold the newest
    // set and warm once control arrives. One listener suffices: later
    // controller changes (a new SW version mid-session) need no special
    // handling because every /home arrival calls this again anyway.
    const first = pending == null;
    pending = items;
    if (first) {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          const held = pending;
          pending = null;
          if (held) precacheContinueWatching(held);
        },
        { once: true }
      );
    }
    return;
  }

  if (running) {
    // A revalidated /home mid-pass: remember the newest set; the running
    // pass drains it next (already-fresh URLs make the rerun nearly free).
    queued = items;
    return;
  }

  running = true;
  void (async () => {
    try {
      let batch: PrecacheItem[] | null = items;
      while (batch) {
        for (const item of batch.slice(0, MAX_SHOWS)) {
          if (!navigator.onLine) return; // network died mid-pass — a later visit retries
          // The page cache keys on the api path WITHOUT the /api prefix (that
          // is what api.ts prepends), so seed `base` while warming `/api+base`.
          const base = `/${item.kind === "movie" ? "movies" : "shows"}/${item.id}`;
          if (!(await warmSeed(`/api${base}`, base))) return; // session ended — stop warming
          // The detail page's hero art. Built with the same img.ts helpers
          // (and sizes) the page uses, so its <img> URLs hit these cache
          // entries. no-cors matches how <img> loads them — the SW stores
          // the opaque response in its image cache.
          const p = poster(item.poster);
          if (p) await warm(p, { mode: "no-cors" });
          const b = backdrop(item.backdrop);
          if (b) await warm(b, { mode: "no-cors" });
        }
        batch = queued;
        queued = null;
      }
    } finally {
      running = false;
    }
  })();
}
