import { enqueue, hasPending, isQueueable, markReachable } from "./offline";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { allow401?: boolean }): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : null;

  // Watch/unwatch/favorite mutations survive offline: when the network is
  // gone — or a queued backlog is still draining and order matters — record
  // the op in the offline queue and answer as the server would, so pages
  // apply their optimistic update and the change syncs later.
  const queueable = isQueueable(method, path);
  if (queueable && (!navigator.onLine || hasPending())) {
    await enqueue(method, path, body);
    return { ok: true, queued: true } as T;
  }

  // Unsafe methods always declare JSON so the server's CSRF content-type check
  // passes — including empty-body mutations like logout and
  // del(), which previously sent no Content-Type at all. Caller-supplied
  // headers still win via the spread below.
  const unsafe = method !== "GET" && method !== "HEAD";

  let res: Response;
  try {
    res = await fetch("/api" + path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(unsafe ? { "content-type": "application/json" } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    if (queueable) {
      await enqueue(method, path, body);
      return { ok: true, queued: true } as T;
    }
    markReachable(false);
    throw new ApiError(0, "You're offline");
  }
  // The service worker marks API responses it had to serve from cache.
  markReachable(!res.headers.has("x-sw-fallback"));
  if (res.status === 401 && !init?.allow401 && !path.startsWith("/auth")) {
    window.location.assign("/login");
    throw new ApiError(401, "unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const post = (path: string, body?: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
export const put = (path: string, body?: unknown) =>
  api(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
// DELETE takes an optional JSON body: an un-tick carries the SCOPE of what
// the user acted on ({ scope: 'round' | 'play' | 'all' }), so a replay out of
// the offline queue — which stores the body and sends it back verbatim —
// can't be reinterpreted by whatever the server's state looks like whenever
// it lands. Without it, undoing one rewatch tick could arrive after the round
// closed and be read as "delete this episode's whole history".
export const del = (path: string, body?: unknown) =>
  api(path, { method: "DELETE", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
