// Precache for offline browsing: Continue Watching (issue #139) and, since
// issue #183, the user's whole library.
//
// Offline support (issue #51) caches API responses and images as they're
// fetched, so a show's detail page only works offline if the user happened
// to open it while online. Two proactive passes close that gap:
//
//   - precacheContinueWatching (issue #139): when /home data arrives, warm
//     each Continue Watching show's detail payload + hero art (poster AND
//     w1280 backdrop) and seed the parsed payload into the in-memory page
//     cache (hooks.ts, issue #154 follow-up) so an ONLINE tap paints the
//     detail page instantly.
//   - precacheLibrary (issue #183): shortly after a signed-in session is
//     known (app.tsx), warm the index payloads (/library, /watchlist,
//     /lists, /home) and EVERY library title's detail payload + w342 poster
//     (the same URL the Library grid and the detail hero render), so in
//     airplane mode the Library, Watchlist, Lists index, Watch Next, and
//     every show/movie page open from cache. Backdrops stay CW-only — w1280
//     art for a whole library would blow the image budget; a detail page
//     without its backdrop just renders without hero art. Comments are
//     deliberately never precached (the issue: too much space) — offline
//     they're readable only where normal browsing already cached them.
//
// All warming flows through the service worker's existing runtime caches
// (network-first api, cache-first img) — offline navigation then resolves
// entirely from cache, and watch/unwatch/favorite actions queue in the
// offline mutation queue (offline.ts) to sync on reconnect.
//
// Bounds: CW warms only the front of the row (MAX_SHOWS); the library pass
// caps at LIBRARY_MAX titles and — because Cache Storage is shared between
// the SW and the page — skips anything already cached fresh (detail payloads
// younger than DETAIL_FRESH_MS, posters at all), so repeat passes fetch only
// new and expired titles instead of re-downloading the library every boot.
// Each URL also re-warms at most once per FRESH_MS per page load (warmedAt).
// Fetches run sequentially so warming never competes with the page for
// bandwidth. The SW's cache caps (MAX_API/MAX_IMG, trimmed oldest-first)
// still bound total storage — nothing here grows a cache unbounded.

import { backdrop, poster } from "./img";
import { cacheGeneration, setCached, getCached, readApiCache, SW_API_CACHE, SW_IMG_CACHE } from "./hooks";

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

// ---------- Full-library precache (issue #183) ----------

// Titles per pass. Keeps the pass comfortably inside the SW's api cache cap
// (MAX_API in sw.js) with headroom left for indexes, comment threads, and
// everything else runtime browsing caches.
const LIBRARY_MAX = 500;

// A detail payload cached within the last day is "warm enough" for offline —
// normal browsing (network-first) and the post-sync revalidation keep pages
// the user actually opens fresher than this anyway.
const DETAIL_FRESH_MS = 24 * 60 * 60 * 1000;

// When `url`'s cached copy landed, by its response Date header: undefined =
// no entry at all, null = an entry whose date can't be read (opaque no-cors
// image responses have no visible headers, so poster hits land here).
async function cachedAt(cacheName: string, url: string): Promise<number | null | undefined> {
  if (!("caches" in window)) return undefined;
  try {
    const hit = await (await caches.open(cacheName)).match(url);
    if (!hit) return undefined;
    const t = Date.parse(hit.headers.get("date") ?? "");
    return Number.isNaN(t) ? null : t;
  } catch {
    return undefined;
  }
}

// An entry exists and is younger than maxAge. An unreadable date counts as
// fresh: the entry is present and usable offline (which is what matters),
// and re-fetching it forever would gain nothing.
async function freshInCache(cacheName: string, url: string, maxAge: number): Promise<boolean> {
  const at = await cachedAt(cacheName, url);
  return at !== undefined && (at === null || Date.now() - at < maxAge);
}

// The library/watchlist rows carry exactly what the pass needs: the id to
// build the detail URL and the poster path both the grid and the hero use.
interface IndexTitle {
  id: number;
  poster: string | null;
}
interface LibraryIndex {
  shows: IndexTitle[];
  movies: IndexTitle[];
  animeShows: IndexTitle[];
  animeMovies: IndexTitle[];
}
interface WatchlistIndex {
  shows: IndexTitle[];
  movies: IndexTitle[];
}

// An index payload for the pass to enumerate: a fresh SW-cache entry is
// reused as-is (seeding the in-memory page cache only when it's empty — the
// page cache can hold a NEWER copy than the SW's, e.g. right after a
// mutation-triggered refetch, and must not be clobbered with older data);
// otherwise fetched, which lands it in the SW cache via the api handler and
// seeds the page cache like warmSeed. Returns null when unavailable
// (offline, error, cache fallback, 401) — the caller stops the pass; the
// next trigger retries.
async function indexPayload<T>(path: string, gen: number, force = false): Promise<T | null> {
  const url = "/api" + path;
  if (!force && (await freshInCache(SW_API_CACHE, url, FRESH_MS))) {
    const data = await readApiCache<T>(path);
    if (data !== undefined) {
      if (getCached(path) === undefined) setCached(path, data, gen);
      return data;
    }
  }
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok || res.headers.has("x-sw-fallback")) {
      void res.body?.cancel();
      return null;
    }
    const data = (await res.json()) as T;
    setCached(path, data, gen);
    warmedAt.set(url, Date.now());
    return data;
  } catch {
    return null;
  }
}

// Ask the ACTIVE service worker for its cache caps (issue #183). After a
// deploy the page can be new while the controlling worker is still the old
// one (updates park in `waiting` until the user accepts the toast or every
// tab closes — issue #172). An old worker would trim the library warm right
// back out of its smaller-capped caches, so the pass runs only once the
// controller answers with caps that fit; an old worker never answers (it
// predates GET_CAPS) and the timeout resolves null.
function controllerCaps(): Promise<{ maxApi: number } | null> {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker.controller;
    if (!ctrl) return resolve(null);
    const ch = new MessageChannel();
    const timer = window.setTimeout(() => resolve(null), 2000);
    ch.port1.onmessage = (e) => {
      window.clearTimeout(timer);
      resolve(e.data && typeof e.data.maxApi === "number" ? { maxApi: e.data.maxApi } : null);
    };
    try {
      ctrl.postMessage({ type: "GET_CAPS" }, [ch.port2]);
    } catch {
      window.clearTimeout(timer);
      resolve(null);
    }
  });
}

let libRunning = false;
let libQueued = false; // triggered again mid-pass (e.g. account switch) — run once more after
let libWaiting = false; // parked on SW control / connectivity coming back
let libForce = false; // the next pass must refetch the index payloads (post-import)

// Warm the offline cache for the user's entire library (issue #183). Called
// from app.tsx shortly after a signed-in session is known, and again when an
// import finishes; fire-and-forget. Cheap when repeated: everything cached
// fresh is skipped (see the header comment), so only new and expired titles
// actually hit the network. `freshIndexes` forces the index payloads
// (/library etc.) to refetch even when age-fresh — after an import their
// cached copies are minutes old but no longer list the whole library.
export function precacheLibrary(freshIndexes = false): void {
  if (freshIndexes) libForce = true;
  if (!("serviceWorker" in navigator)) return;

  // Offline (or the SW not yet controlling a first-visit page): park ONE
  // retry on the event that unblocks us. Both conditions re-check on re-entry.
  if (!navigator.onLine || !navigator.serviceWorker.controller) {
    if (libWaiting) return;
    libWaiting = true;
    const retry = () => {
      libWaiting = false;
      precacheLibrary();
    };
    if (!navigator.onLine) window.addEventListener("online", retry, { once: true });
    else navigator.serviceWorker.addEventListener("controllerchange", retry, { once: true });
    return;
  }

  if (libRunning) {
    libQueued = true;
    return;
  }
  libRunning = true;
  void (async () => {
    try {
      // A pre-#183 worker still controls the page — skip this session (see
      // controllerCaps above); the next launch runs under the new worker.
      const caps = await controllerCaps();
      if (!caps || caps.maxApi < LIBRARY_MAX) return;
      do {
        libQueued = false;
        await libraryPass();
      } while (libQueued);
    } finally {
      libRunning = false;
    }
  })();
}

async function libraryPass(): Promise<void> {
  const force = libForce;
  libForce = false;
  // The account this pass belongs to, like warmSeed: a sign-out/sign-in
  // mid-pass aborts (the SW api cache was wiped by the identity change, and
  // the new account's own trigger re-runs the pass for its library).
  const gen = cacheGeneration();

  const lib = await indexPayload<LibraryIndex>("/library", gen, force);
  if (!lib || cacheGeneration() !== gen) return;
  const wl = await indexPayload<WatchlistIndex>("/watchlist", gen, force);
  if (cacheGeneration() !== gen) return;

  // Watch Next and the Lists index open offline too. Warm-only: Continue
  // Watching details are precacheContinueWatching's job, and custom-list
  // DETAIL payloads are deliberately not precached (bounded scope — titles
  // that are also in the library are covered below anyway).
  for (const path of ["/home", "/lists"]) {
    if (!navigator.onLine || cacheGeneration() !== gen) return;
    const url = "/api" + path;
    if (force) warmedAt.delete(url); // an age-fresh copy predates the import — re-warm anyway
    if ((force || !(await freshInCache(SW_API_CACHE, url, FRESH_MS))) && !(await warm(url))) return;
  }

  const title =
    (kind: "show" | "movie") =>
    (t: IndexTitle): { kind: "show" | "movie"; id: number; poster: string | null } => ({ kind, id: t.id, poster: t.poster });
  // Defensive ?? []: an index can come from the SW cache, so never assume shape.
  const items = [
    ...(lib.shows ?? []).map(title("show")),
    ...(lib.animeShows ?? []).map(title("show")),
    ...(wl?.shows ?? []).map(title("show")),
    ...(lib.movies ?? []).map(title("movie")),
    ...(lib.animeMovies ?? []).map(title("movie")),
    ...(wl?.movies ?? []).map(title("movie")),
  ].slice(0, LIBRARY_MAX);

  // Consecutive detail warms that produced no cached copy: the server being
  // unreachable while navigator.onLine still reads true (captive portal,
  // outage) fails every request — stop churning through the whole list after
  // a few in a row. Isolated failures (one deleted title's 404) reset.
  let misses = 0;

  for (const item of items) {
    if (!navigator.onLine || cacheGeneration() !== gen) return;
    const url = `/api/${item.kind === "movie" ? "movies" : "shows"}/${item.id}`;
    // Skip payloads cached in the last day (by normal browsing, the CW pass,
    // or a previous library pass); a 401 ends the session — stop warming.
    if (!(await freshInCache(SW_API_CACHE, url, DETAIL_FRESH_MS))) {
      if (!(await warm(url))) return;
      // warm() stamps warmedAt only when a real network response was cached,
      // so a just-warmed URL reads fresh; an old stamp (>FRESH_MS) doesn't.
      if (isFresh(url)) misses = 0;
      else if (++misses >= 3) return; // unreachable or erroring — the next trigger retries
    }
    // The w342 poster both the Library grid and the detail hero render.
    // Cache-first in the SW, so presence is enough — no age check.
    const p = poster(item.poster);
    if (p && (await cachedAt(SW_IMG_CACHE, p)) === undefined) await warm(p, { mode: "no-cors" });
  }
}
