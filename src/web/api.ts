export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { allow401?: boolean }): Promise<T> {
  const res = await fetch("/api" + path, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
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
export const del = (path: string) => api(path, { method: "DELETE" });
