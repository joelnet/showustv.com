import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { onRevalidate } from "./offline";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// ---------- Page-data cache (issue #154) ----------
//
// A module-level stale-while-revalidate store behind useApi. Navigating back
// to a page renders its last-known data instantly — the loading skeleton only
// appears on the first, cold visit — while every mount still refetches in the
// background and swaps in fresh data when it lands. So after any mutation
// elsewhere (marking watched, list edits, …), a revisited page can show stale
// data for at most one network round trip before it self-corrects.
//
// The cache is in-memory only, keyed by API path: a hard refresh starts
// clean, and the service worker already covers offline persistence. It
// belongs to one account — setCacheUser wipes it whenever the signed-in
// identity changes. app.tsx calls that synchronously inside setUser (like it
// zeroes the unread store), before anything re-renders under the new user,
// so one account's pages can never flash for the next.

const MAX_ENTRIES = 50;
const cache = new Map<string, unknown>();
// Newest-issued request per path, so an older in-flight response can't
// overwrite a newer one in the cache (e.g. a post-mutation reload racing a
// slow mount-time refetch).
const latest = new Map<string, Promise<unknown>>();
let cacheUid: number | null = null;
// Bumped on every account change. A fetch that began under one account and
// resolves under another is stale — carrying its generation lets the seed
// write drop itself instead of leaking one account's data into the next.
let cacheGen = 0;

export function setCacheUser(uid: number | null): void {
  if (uid === cacheUid) return;
  cacheUid = uid;
  cacheGen++;
  cache.clear();
  latest.clear(); // fetches still in flight for the old account may not populate the cache
}

// The account generation at call time — captured before a background fetch so
// its later seed can verify the account hasn't changed since (see setCached).
export function cacheGeneration(): number {
  return cacheGen;
}

// Targeted invalidation for mutate-then-navigate flows (e.g. deleting a list
// and jumping to /lists): the destination cold-loads instead of flashing the
// pre-mutation copy.
export function dropCached(path: string): void {
  cache.delete(path);
  latest.delete(path);
}

function put(path: string, data: unknown): void {
  cache.delete(path); // re-insert so eviction order tracks write recency
  cache.set(path, data);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

// Seed the cache from outside useApi (issue #154 follow-up). The Continue
// Watching precache (precache.ts) already fetches each show/movie detail
// payload to warm the service worker's offline cache — it hands the same body
// here too, so opening one of those tiles paints the detail page from cache
// with no loading skeleton. Writes land in the same map (with the same
// eviction and per-user clearing) useApi reads, so a seeded entry is dropped
// on sign-out like any other.
//
// `gen` guards against an account switch during the background fetch: a caller
// captures cacheGeneration() before fetching and passes it here; a stale
// generation means someone else has signed in since, so the write is dropped
// rather than leaked into their cache. (useApi's own revalidation is covered
// instead by the latest-map clear in setCacheUser.)
export function setCached(path: string, data: unknown, gen?: number): void {
  if (gen !== undefined && gen !== cacheGen) return;
  put(path, data);
}

// The current cached value for a path, if any — for pages that fetch outside
// useApi (show.tsx) but still want the instant warm paint.
export function getCached<T = unknown>(path: string): T | undefined {
  return cache.get(path) as T | undefined;
}

// Fetch `path`, recording the result for later warm renders. Successes only:
// a failed refresh never clobbers good cached data.
function revalidate<T>(path: string): Promise<T> {
  const p = api<T>(path);
  latest.set(path, p);
  p.then(
    (data) => {
      if (latest.get(path) !== p) return; // superseded (newer request or account switch)
      latest.delete(path);
      put(path, data);
    },
    () => {
      if (latest.get(path) === p) latest.delete(path);
    }
  );
  return p;
}

// Stale-while-revalidate: a warm path (cached, or a reload() on data already
// on screen) keeps the current data visible and swaps it silently — only a
// cold load shows a loading state.
export function useApi<T = any>(path: string | null) {
  // Seed from the cache so the very first paint after navigating back to a
  // page already shows its data — no skeleton frame.
  const [state, set] = useState<ApiState<T>>(() => {
    const cached = path ? (cache.get(path) as T | undefined) : undefined;
    return { data: cached ?? null, loading: !!path && cached === undefined, error: null };
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    // `live` is per effect run, and React runs this cleanup before re-running
    // the effect on a reload()/path change — so it guards both unmount AND
    // superseded requests: a slow response from before a reload can never
    // paint over the newer one (only the cache write races, and `latest`
    // settles that).
    let live = true;
    const cached = cache.get(path) as T | undefined;
    set({ data: cached ?? null, loading: cached === undefined, error: null });
    revalidate<T>(path)
      .then((data) => live && set({ data, loading: false, error: null }))
      .catch((e) => {
        if (!live) return;
        // With cached data on screen, a transient failure (offline, 5xx)
        // keeps the page as-is — the offline banner explains why. A
        // definitive 4xx means the resource is gone or denied: drop the
        // stale copy and surface the error like a cold load would.
        const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
        if (definitive) dropCached(path);
        if (cached !== undefined && !definitive) return;
        set({ data: null, loading: false, error: e.message });
      });
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Refetch when connectivity returns or queued offline changes finish
  // syncing — stale cache-served data on screen gets replaced silently.
  useEffect(() => onRevalidate(reload), [reload]);

  return { ...state, reload };
}
