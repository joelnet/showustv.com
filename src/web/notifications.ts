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

// Ask permission, subscribe this device, and register the subscription with
// the server. Must be called from a user gesture (the settings toggle).
// Throws with a user-facing message on the known failure modes.
export async function enablePush(publicKey: string): Promise<void> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported in this browser");
  // Raced against a timeout: a corrupted installed-app permission binding
  // (Android WebAPK) can leave requestPermission() pending forever without
  // ever showing a prompt, which used to strand the toggle dimmed with no
  // error. Reinstalling the app is what actually fixes such a device, so
  // that's what the timeout says. 20s is enough to read a real prompt; a
  // slower answer still registers with the browser, so the next attempt
  // succeeds without prompting.
  const permission = await Promise.race([
    Notification.requestPermission(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Couldn't get an answer asking for notification permission — if this is an installed app, uninstalling and reinstalling it usually fixes this"
            )
          ),
        20_000
      )
    ),
  ]);
  if (permission === "denied") throw new Error("Notifications are blocked for this site in your browser settings");
  if (permission !== "granted")
    // "default" with no prompt shown is the same broken installed-app
    // permission binding as the hang above, just one step further along.
    throw new Error(
      "The notification permission prompt wasn't answered — if no prompt appeared, uninstall and reinstall the app"
    );
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    }));
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
