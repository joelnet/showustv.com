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

// ---------- Push-nudge store (issue #276) ----------
// While this device COULD receive pushes but isn't subscribed — the same
// off-but-enable-able condition the notifications page's PushToggle discover
// mode uses (issue #237): push supported, VAPID key configured, no current
// subscription — the bell badge shows at least (1) to pull people onto the
// page where the enable toggle lives. Purely a display nudge: the real
// unread store above (and the server's read state) is never touched.

let pushNudge = false;
const nudgeListeners = new Set<() => void>();

const subscribeNudge = (cb: () => void) => {
  nudgeListeners.add(cb);
  return () => {
    nudgeListeners.delete(cb);
  };
};

// Every set bumps the generation, so an async check that was already in
// flight when enable/disable answered directly can tell it's stale and must
// not overwrite that answer (e.g. a slow prefs fetch from mount resolving
// right after the toggle subscribed — it would resurrect the (1)).
let nudgeGen = 0;

function setPushNudge(on: boolean): void {
  nudgeGen++;
  if (on !== pushNudge) {
    pushNudge = on;
    nudgeListeners.forEach((l) => l());
  }
}

// Every failure path lands on "no nudge": a wrong (1) that outlives an
// enable, or one shown while signed out/offline, is worse than no nudge.
async function checkPushNudge(): Promise<void> {
  const gen = nudgeGen;
  const stale = () => gen !== nudgeGen;
  if (!pushSupported()) return setPushNudge(false);
  try {
    const sub = await getPushSubscription();
    if (stale()) return;
    if (sub) return setPushNudge(false);
    // Only unsubscribed devices pay for the prefs fetch; it doubles as the
    // signed-in check (the route 401s otherwise).
    const d = await api<{ pushPublicKey: string | null }>("/notifications/prefs");
    if (stale()) return;
    setPushNudge(!!d.pushPublicKey);
  } catch {
    if (!stale()) setPushNudge(false);
  }
}

// Whether the bell should show the synthetic minimum. Checked once per mount
// (one bell per shell); enablePush/disablePush below flip it live, so the
// nudge disappears the moment the toggle subscribes this device.
export function usePushNudge(): boolean {
  const nudge = useSyncExternalStore(subscribeNudge, () => pushNudge);
  useEffect(() => {
    void checkPushNudge();
  }, []);
  return nudge;
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

function applicationServerKey(publicKey: string): BufferSource {
  const key = urlBase64ToUint8Array(publicKey);
  // VAPID public keys are uncompressed P-256 points. Browsers usually throw
  // their own low-level error for bad keys, but this keeps the toggle from
  // presenting key/config mistakes as a user permission decision.
  if (key.length !== 65 || key[0] !== 4)
    throw new Error("Push notifications are misconfigured: the VAPID public key is invalid");
  return key as unknown as BufferSource;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function isAppleStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const appleMobile =
    /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return appleMobile && nav.standalone === true;
}

function isNotAllowedError(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === "NotAllowedError"
    : e instanceof Error && e.name === "NotAllowedError";
}

async function subscriptionFailureMessage(reg: ServiceWorkerRegistration, e: unknown): Promise<string | null> {
  if (!isNotAllowedError(e) || Notification.permission !== "granted") return null;
  const pushPermission = await withTimeout(
    reg.pushManager.permissionState({ userVisibleOnly: true }),
    3_000,
    "Couldn't read notification permission from the installed app"
  ).catch(() => null);
  if (pushPermission === "denied") return "Notifications are blocked for this site in your browser settings";
  if (pushPermission === "granted") {
    if (isAppleStandalonePwa())
      return "iOS allowed notifications, but refused to create a push subscription. This is common in the iOS Simulator; test push on a physical iPhone, or reinstall the Home Screen app if this is a real device.";
    return "The browser allowed notifications, but refused to create a push subscription. Reset this site's notification permission or reinstall the app.";
  }
  return null;
}

// Subscribe this device and register the subscription with the server. Must
// be called from a user gesture (the settings toggle). PushManager.subscribe
// owns the permission request per the Push API; calling
// Notification.requestPermission first wastes the short-lived user activation
// and, on Android WebAPKs, takes a separate permission-delegation path that can
// wedge without ever showing a prompt.
export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported in this browser");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    if (Notification.permission === "denied")
      throw new Error("Notifications are blocked for this site in your browser settings");
    try {
      sub = await withTimeout(
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }),
        20_000,
        "Couldn't create a push subscription in this installed app"
      );
    } catch (e) {
      const message = await subscriptionFailureMessage(reg, e);
      if (message) throw new Error(message);
      if (Notification.permission === "default")
        throw new Error(
          "Chrome didn't open the installed app's notification prompt. Close the app, toggle its Notifications permission off and on in Android settings, then try again"
        );
      throw e;
    }
  }
  await post("/notifications/push/subscribe", sub.toJSON());
  setPushNudge(false); // this device now gets pushes — the bell's (1) nudge goes away
}

// Drop this device's subscription, server-side and browser-side — in that
// order. Once the server row is gone no more pushes are sent even if the
// browser-side unsubscribe fails; the reverse order could strand a live row
// pointing at a subscription we can no longer name.
export async function disablePush(): Promise<void> {
  const sub = await getPushSubscription();
  if (!sub) return;
  await post("/notifications/push/unsubscribe", { endpoint: sub.endpoint });
  const gone = await sub.unsubscribe().catch(() => false);
  // Nudge again only if the browser-side unsubscribe really happened —
  // that's what makes this device off-but-enable-able per the detection
  // above (a surviving subscription would contradict the (1), and the
  // discover toggle wouldn't show either).
  setPushNudge(gone);
}
