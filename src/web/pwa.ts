// PWA plumbing: service-worker registration, beforeinstallprompt capture,
// and new-version detection (issue #172). Modeled on open.raweditor.io's
// src/pwa.js, adapted to React — events are captured once at boot (they can
// fire before any component mounts) and components subscribe via
// useInstallPrompt() / useUpdateReady().

import { useSyncExternalStore } from "react";

// Chromium-only event; not in lib.dom.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes installed state here instead of display-mode.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as macOS, but Macs have no touch points.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// ---------- New-version detection (issue #172) ----------
// Every deploy changes the sw.js bytes (build-stamped, see vite.config.ts),
// so the browser installs the new worker, which parks in `waiting` instead
// of activating (install no longer calls skipWaiting — see sw.js). We watch
// for that, and only when a controller already exists — an existing
// controller means this is an update behind a live page, not a first
// install — flip updateReady, which renders the UpdateToast (app.tsx).

let registration: ServiceWorkerRegistration | null = null;
let updateReady = false;
const updateListeners = new Set<() => void>();

function markUpdateReady() {
  if (updateReady) return;
  updateReady = true;
  updateListeners.forEach((l) => l());
}

function watchForUpdates(reg: ServiceWorkerRegistration) {
  registration = reg;
  // Deployed while no tab was open: the update is already installed, parked.
  if (reg.waiting && navigator.serviceWorker.controller) markUpdateReady();
  const track = (next: ServiceWorker | null) => {
    if (!next) return;
    next.addEventListener("statechange", () => {
      // `installed` with an existing controller = a new deploy finished
      // installing behind this page. Without a controller it is the very
      // first install — never toast that.
      if (next.state === "installed" && navigator.serviceWorker.controller) markUpdateReady();
    });
  };
  // An update can already be mid-install by the time register() resolves
  // (its updatefound fired before we could listen) — watch it too.
  track(reg.installing);
  reg.addEventListener("updatefound", () => track(reg.installing));
}

// The browser only re-fetches sw.js on its own schedule (navigations, ~24h),
// so a long-lived tab would miss a deploy for hours. Nudge it whenever the
// user comes back to the tab, plus a slow interval for a tab that never
// blurs. Throttled: focus and visibilitychange fire together, and rapid
// alt-tabbing shouldn't turn into a request storm.
const CHECK_MIN_GAP_MS = 60_000;
const CHECK_INTERVAL_MS = 30 * 60_000;
let lastCheck = Date.now();

function checkForUpdate() {
  if (!registration || updateReady) return;
  const now = Date.now();
  if (now - lastCheck < CHECK_MIN_GAP_MS) return;
  lastCheck = now;
  registration.update().catch(() => {}); // offline / transient — next nudge retries
}

// Armed only by applyUpdate(): the controllerchange fired by clients.claim()
// on a first install must not reload, and the `reloaded` latch makes a
// reload loop impossible even if the event ever fired twice.
let reloadRequested = false;
let reloaded = false;

/** The update toast's action: activate the waiting worker and reload into it. */
export function applyUpdate() {
  reloadRequested = true;
  const waiting = registration?.waiting;
  if (waiting) {
    // sw.js answers with skipWaiting(); activation fires controllerchange,
    // handled in initPwa below, which reloads this page once.
    waiting.postMessage({ type: "SKIP_WAITING" });
  } else {
    // No waiting worker anymore (another tab already promoted it, or the
    // browser discarded it) — a plain reload lands on the current version.
    window.location.reload();
  }
}

const subscribeUpdate = (cb: () => void) => {
  updateListeners.add(cb);
  return () => {
    updateListeners.delete(cb);
  };
};
const getUpdateSnapshot = () => updateReady;

/** True once a fresh deploy is installed and waiting — show the update toast. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribeUpdate, getUpdateSnapshot);
}

// Call once at boot, before React renders.
export function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then(watchForUpdates).catch(() => {});
    });

    // One reload when the new worker takes control after the user accepted
    // the update. Gated by reloadRequested (see above) so first-install
    // claim() and updates applied from another tab never reload this one.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloadRequested || reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    // Proactive checks so a deploy is noticed while the app sits open.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    window.addEventListener("focus", checkForUpdate);
    window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });

  // Fires regardless of how the install happened (our button, the
  // browser's address-bar affordance, ...).
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getSnapshot = () => deferredPrompt !== null;

/**
 * Install-App state for UI. `available` — show an install affordance at all
 * (never when already running installed). On iOS, which never fires
 * beforeinstallprompt, it's always on and `install` is a no-op: show manual
 * Add-to-Home-Screen instructions instead. On Chromium it turns on when the
 * browser says the app is installable.
 */
export function useInstallPrompt() {
  const canPrompt = useSyncExternalStore(subscribe, getSnapshot);
  const ios = !canPrompt && isIos();
  return {
    available: !isStandalone() && (canPrompt || ios),
    ios,
    install: () => {
      if (!deferredPrompt) return;
      const prompt = deferredPrompt;
      // The event is single-use; hide until the browser fires a fresh one.
      deferredPrompt = null;
      notify();
      void prompt.prompt();
    },
  };
}
