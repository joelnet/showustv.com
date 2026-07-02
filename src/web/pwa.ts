// PWA plumbing: service-worker registration and beforeinstallprompt capture.
// Modeled on open.raweditor.io's src/pwa.js, adapted to React — the event is
// captured once at boot (it can fire before any component mounts) and
// components subscribe via useInstallPrompt().

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

// Call once at boot, before React renders.
export function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
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
