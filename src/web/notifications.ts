// Notifications client plumbing (issue #129): the unread-count store behind
// the header bell, and the Web Push subscribe/unsubscribe flow the settings
// page drives. The store also mirrors the count onto the installed PWA's
// app icon via the Badging API (issue #142).

import { useEffect, useSyncExternalStore } from "react";
import { api, post } from "./api";

// ---------- Unread badge store (useSyncExternalStore, like pwa.ts) ----------

let unread = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

// App-icon badging (issue #142): keep the home-screen/dock icon's badge in
// lockstep with the bell. Best-effort by design — the API only exists in
// some browsers, only does anything for an installed PWA, and the promise
// can reject — so every failure mode is swallowed; the in-app bell is the
// fallback everywhere else.
function applyAppBadge(n: number): void {
  if (!("setAppBadge" in navigator)) return;
  try {
    void (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch {
    // synchronous throw (odd platform) — nothing to do
  }
}

export function setUnread(n: number): void {
  // Applied even when the store value is unchanged: the service worker sets
  // the OS badge independently (push handler), so this is also the recovery
  // path when the two drift — e.g. sign-out while the store already reads 0
  // but a queued push left a stale badge behind.
  applyAppBadge(n);
  if (n !== unread) {
    unread = n;
    notify();
  }
}

export async function refreshUnread(): Promise<void> {
  try {
    const d = await api<{ count: number }>("/notifications/unread-count");
    setUnread(d.count);
  } catch {
    // offline or signed out — keep the last known badge; the next poll fixes it
  }
}

const POLL_MS = 90_000;

// Live unread count for the bell. The mounting component (one bell per shell)
// owns the polling: refresh on mount, on tab focus, and on a slow interval.
export function useUnreadNotifications(): number {
  const count = useSyncExternalStore(subscribe, () => unread);
  useEffect(() => {
    void refreshUnread();
    const onFocus = () => void refreshUnread();
    window.addEventListener("focus", onFocus);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refreshUnread();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, []);
  return count;
}

// ---------- Web Push subscription flow ----------

// iOS Safari only exposes PushManager inside an installed (home-screen) PWA,
// so "unsupported" there really means "not installed yet" — settings shows
// the install hint for that case.
export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// The VAPID public key arrives base64url-encoded; PushManager wants raw bytes.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Ask permission, subscribe this device, and register the subscription with
// the server. Must be called from a user gesture (the settings toggle).
// Throws with a user-facing message on the known failure modes.
export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported in this browser");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site in your browser settings");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    }));
  await post("/notifications/push/subscribe", sub.toJSON());
}

// Drop this device's subscription, server-side and browser-side — in that
// order. Once the server row is gone no more pushes are sent even if the
// browser-side unsubscribe fails; the reverse order could strand a live row
// pointing at a subscription we can no longer name.
export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  await post("/notifications/push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}
