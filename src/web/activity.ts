// Background-activity store (issue #204): counts in-flight background work —
// the cache-warming passes in precache.ts today — so the header can show a
// thin progress sweep while the app is downloading data to the local cache.
// Same useSyncExternalStore pattern as offline.ts / pwa.ts. The offline
// mutation queue is NOT counted here; its replay already exposes `syncing`
// via useOffline(), and the header combines the two.

import { useSyncExternalStore } from "react";

let active = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Mark one background task as running. Returns a release function that is
// safe to call more than once — each begin releases exactly once, so a
// double release can never strand the counter below zero (which would hide
// another task's activity).
export function beginBackgroundActivity(): () => void {
  active++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active--;
    emit();
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const useBackgroundActivity = (): boolean => useSyncExternalStore(subscribe, () => active > 0);
