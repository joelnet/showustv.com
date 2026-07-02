// Offline mode (issue #8): a durable mutation queue plus connectivity status.
//
// Watch/unwatch/favorite actions are "queueable": when the network is gone
// (or a queued backlog is still draining — order matters) api.ts records
// them here instead of failing, and pages apply their optimistic update as
// if the server had answered. Ops live in IndexedDB so they survive
// reloads, coalesce per entity (watch → unwatch keeps only the unwatch),
// and replay in queue order when connectivity returns. Watch POSTs get a
// watched_at stamped at enqueue time — the API supports backdating, so a
// mark replayed hours later keeps the moment the user actually acted.
// Unwatch/favorite can't express "when"; replay order suffices for those.
//
// Safety rails:
//   - Every op is stamped with the signed-in user's id (app.tsx keeps
//     setOfflineUser in sync with /auth/me) and replay refuses to send ops
//     across accounts — a 401-paused backlog must not land in whoever signs
//     in next on this browser. Mismatched ops are dropped and surfaced.
//   - Replay runs under a cross-tab Web Lock (IndexedDB lease fallback), so
//     two tabs can't both send the same op and double-apply it.
//
// Replay failures: network errors and 5xx are transient (stop, retry
// shortly); other 4xx are permanent (the server will never accept the op —
// drop it and surface the loss); 401 pauses the queue until re-login.

import { useSyncExternalStore } from "react";

interface QueuedOp {
  id: number;
  uid: number | null; // who queued it — ops never replay across accounts
  method: string;
  path: string; // api path, without the /api prefix
  body: string | null;
  key: string; // coalescing key — at most one live op per entity
  queuedAt: string;
}

interface Rule {
  re: RegExp;
  key: (m: RegExpExecArray) => string;
  stampWatchedAt?: boolean; // POST body accepts a backdated watched_at
  // When set, a newer op replaces an older same-key one only if this says
  // the newer op fully covers the older one; otherwise both stay queued.
  subsumes?: (newBody: string | null, oldBody: string | null) => boolean;
}

const QUEUEABLE: Rule[] = [
  { re: /^\/episodes\/(\d+)\/watch$/, key: (m) => `episode:${m[1]}`, stampWatchedAt: true },
  { re: /^\/shows\/(\d+)\/seasons\/(\d+)\/watch$/, key: (m) => `show:${m[1]}:season:${m[2]}` },
  { re: /^\/shows\/(\d+)\/watch-all$/, key: (m) => `show:${m[1]}:watch-all` },
  {
    re: /^\/shows\/(\d+)\/watch-until$/,
    key: (m) => `show:${m[1]}:watch-until`,
    // Coalesce only when the newer catch-up provably covers the older one:
    // queueing "watch until S1E3" after "watch until S1E5" must not
    // silently lose E4–E5 — in that case both replay, in order.
    subsumes: (newBody, oldBody) => {
      try {
        const a = JSON.parse(newBody!);
        const b = JSON.parse(oldBody!);
        return a.season > b.season || (a.season === b.season && a.number >= b.number);
      } catch {
        return false;
      }
    },
  },
  { re: /^\/shows\/(\d+)\/favorite$/, key: (m) => `show:${m[1]}:favorite` },
  { re: /^\/movies\/(\d+)\/watch$/, key: (m) => `movie:${m[1]}`, stampWatchedAt: true },
];

export function isQueueable(method: string, path: string): boolean {
  return method !== "GET" && QUEUEABLE.some((q) => q.re.test(path));
}

// ---------- Status store (useSyncExternalStore, like pwa.ts) ----------

export interface OfflineStatus {
  online: boolean; // false → offline banner; covers airplane mode AND server-unreachable
  pending: number; // queued ops waiting to sync
  syncing: boolean;
  result: "synced" | "failed" | null; // transient post-flush toast
  dropped: number; // ops rejected by the server (4xx) or queued by another account — lost, surfaced in the toast
}

let status: OfflineStatus = { online: true, pending: 0, syncing: false, result: null, dropped: 0 };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<OfflineStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useOffline(): OfflineStatus {
  return useSyncExternalStore(subscribe, () => status);
}

export const hasPending = () => status.pending > 0;

// The queue is per-account. app.tsx calls this whenever the authenticated
// user changes (boot /auth/me, login, logout); replay only runs while the
// signed-in user is known, and only sends ops that user queued.
let currentUid: number | null = null;

export function setOfflineUser(uid: number | null) {
  const changed = uid !== currentUid;
  currentUid = uid;
  if (changed && uid != null) void flush();
}

// Called by api.ts after every fetch: a failed fetch (or a response the
// service worker served from cache — x-sw-fallback) means the server is
// unreachable even if navigator.onLine says otherwise (e.g. wifi without
// internet). A real response flips us back and drains any backlog.
export function markReachable(ok: boolean) {
  if (ok) {
    if (!status.online) {
      setStatus({ online: true });
      // With a backlog, revalidating now would fetch pre-replay server
      // state and visually revert optimistic changes — the flush-completion
      // revalidation handles it instead.
      if (!hasPending()) emitRevalidate();
    }
    if (status.pending > 0) void flush();
  } else if (status.online) {
    setStatus({ online: false });
    scheduleRetry();
  }
}

// ---------- Revalidation (useApi reloads on this) ----------

const revalidateListeners = new Set<() => void>();

export function onRevalidate(cb: () => void): () => void {
  revalidateListeners.add(cb);
  return () => {
    revalidateListeners.delete(cb);
  };
}

const emitRevalidate = () => revalidateListeners.forEach((l) => l());

// ---------- IndexedDB plumbing ----------

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("showustv-offline", 2);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains("ops")) d.createObjectStore("ops", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta"); // flush lease (Web Locks fallback)
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

function idb<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(name: "ops" | "meta", mode: IDBTransactionMode) {
  return (await db()).transaction(name, mode).objectStore(name);
}

async function allOps(): Promise<QueuedOp[]> {
  return idb((await store("ops", "readonly")).getAll() as IDBRequest<QueuedOp[]>);
}

export async function enqueue(method: string, path: string, body: string | null): Promise<void> {
  const rule = QUEUEABLE.find((q) => q.re.test(path))!;
  // Preserve "when": stamp watch marks with the enqueue time unless the
  // caller already backdated them.
  if (rule.stampWatchedAt && method === "POST") {
    const parsed = body ? JSON.parse(body) : {};
    parsed.watched_at ??= new Date().toISOString();
    body = JSON.stringify(parsed);
  }
  const key = rule.key(rule.re.exec(path)!);
  const ops = await store("ops", "readwrite");
  // Coalesce: a newer op on the same entity (queued by the same account)
  // supersedes queued older ones (watch then unwatch → only the unwatch
  // replays; double-watch → one) — unless the rule demands provable
  // subsumption (watch-until) and the newer op doesn't cover the older.
  const existing = await idb(ops.getAll() as IDBRequest<QueuedOp[]>);
  let pending = 1;
  for (const op of existing) {
    if (op.key === key && op.uid === currentUid && (!rule.subsumes || rule.subsumes(body, op.body))) {
      await idb(ops.delete(op.id));
    } else {
      pending++;
    }
  }
  await idb(ops.add({ uid: currentUid, method, path, body, key, queuedAt: new Date().toISOString() }));
  setStatus({ pending });
  if (navigator.onLine) void flush();
}

// Pending ops belong to the session that queued them — drop them on logout
// so they can't replay into whoever signs in next. (Replay also refuses
// cross-account ops by uid, for sessions that expire without this running.)
export async function clearQueue(): Promise<void> {
  await idb((await store("ops", "readwrite")).clear());
  setStatus({ pending: 0 });
}

// ---------- Replay ----------

let flushing = false;
let retryTimer: number | null = null;
let toastTimer: number | null = null;

function scheduleRetry(ms = 15000) {
  if (retryTimer != null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flush();
  }, ms);
}

// The post-flush toast ("All changes synced" / "N changes couldn't sync")
// shows briefly, then clears itself.
function clearResultSoon() {
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    setStatus({ result: null, dropped: 0 });
  }, 5000);
}

// Cross-tab exclusion for browsers without Web Locks: an IndexedDB lease,
// claimed atomically (read + check + write in one readwrite transaction)
// and expiring so a closed tab can't wedge the queue forever.
const LEASE_KEY = "flushLease";
const LEASE_MS = 30000;
const leaseToken = Math.random().toString(36).slice(2);

async function claimLease(): Promise<boolean> {
  const meta = await store("meta", "readwrite");
  const cur = await idb<{ token: string; until: number } | undefined>(meta.get(LEASE_KEY));
  if (cur && cur.token !== leaseToken && cur.until > Date.now()) return false;
  await idb(meta.put({ token: leaseToken, until: Date.now() + LEASE_MS }, LEASE_KEY));
  return true;
}

async function releaseLease(): Promise<void> {
  const meta = await store("meta", "readwrite");
  const cur = await idb<{ token: string } | undefined>(meta.get(LEASE_KEY));
  if (cur?.token === leaseToken) await idb(meta.delete(LEASE_KEY));
}

export async function flush(): Promise<void> {
  if (flushing) return; // per-tab guard
  flushing = true;
  try {
    // Cross-tab guard: two tabs replaying the same queue would each send
    // the same op before the other deletes it, double-applying mutations
    // (e.g. inflating rewatch play_counts). Web Locks are browser-wide;
    // ifAvailable skips when another tab is already draining.
    if (navigator.locks) {
      await navigator.locks.request("showustv-offline-flush", { ifAvailable: true }, async (lock) => {
        if (lock) await flushLoop();
        else setStatus({ pending: (await allOps()).length }); // another tab is draining — just refresh the badge
      });
    } else if (await claimLease()) {
      try {
        await flushLoop();
      } finally {
        await releaseLease();
      }
    }
  } finally {
    flushing = false;
  }
}

async function flushLoop(): Promise<void> {
  let applied = 0;
  let dropped = 0;
  let retry = false;
  try {
    for (;;) {
      const ops = await allOps();
      setStatus({ pending: ops.length, syncing: ops.length > 0 && navigator.onLine && currentUid != null });
      if (!ops.length) break;
      if (!navigator.onLine) break; // the 'online' event re-triggers us
      if (currentUid == null) break; // signed-in user unknown — setOfflineUser re-triggers us
      if (!navigator.locks) void claimLease(); // renew the fallback lease
      const op = ops[0];
      if (op.uid !== currentUid) {
        // Queued under a different (or expired-and-replaced) account —
        // never replay across users; drop and surface the loss.
        dropped++;
        await idb((await store("ops", "readwrite")).delete(op.id));
        continue;
      }
      let res: Response;
      try {
        res = await fetch("/api" + op.path, {
          method: op.method,
          credentials: "same-origin",
          headers: op.body ? { "content-type": "application/json" } : undefined,
          body: op.body ?? undefined,
        });
      } catch {
        // Still unreachable — keep the queue, try again shortly.
        setStatus({ online: false });
        retry = true;
        break;
      }
      if (!status.online) setStatus({ online: true });
      if (res.status === 401) break; // session expired — resume after re-login
      if (res.status >= 500) {
        retry = true; // server trouble — transient, keep the op
        break;
      }
      if (res.ok) applied++;
      else dropped++; // 4xx: the server will never accept it — drop, surface
      await idb((await store("ops", "readwrite")).delete(op.id));
    }
  } finally {
    const pending = await allOps().then((ops) => ops.length, () => status.pending);
    setStatus({
      pending,
      syncing: false,
      result: applied || dropped ? (dropped ? "failed" : "synced") : status.result,
      dropped: status.dropped + dropped,
    });
    if (retry) scheduleRetry();
    if (applied || dropped) {
      emitRevalidate(); // views refetch so server truth replaces optimistic state
      clearResultSoon();
    }
  }
}

// Call once at boot (main.tsx). Replay triggers: app startup (once
// setOfflineUser learns who is signed in), the browser's 'online' event, a
// successful fetch after being unreachable (markReachable), enqueueing
// while online, and a retry timer after transient failures.
export function initOffline() {
  setStatus({ online: navigator.onLine });
  window.addEventListener("online", () => {
    setStatus({ online: true });
    // No backlog → refetch stale cache-served views now; with one, the
    // flush-completion revalidation does it (fetching mid-replay would show
    // pre-change server state and visually revert optimistic updates).
    if (!hasPending()) emitRevalidate();
    void flush();
  });
  window.addEventListener("offline", () => setStatus({ online: false }));
  void flush(); // sets the pending badge; replay waits for setOfflineUser
}
