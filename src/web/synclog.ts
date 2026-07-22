// Client-side sync log (issue #372). A small, capped ring buffer that the
// background-sync steps write to as they work, so an admin can see — live, in
// the admin panel (/admin) — exactly what the header's sync indicator
// (issue #204) is doing: the library and Continue Watching precache passes
// (precache.ts) and the offline mutation-queue replay (offline.ts).
//
// Same useSyncExternalStore pattern as activity.ts / offline.ts.
//
// Deliberately lightweight and non-invasive:
//   - Callers append short OPERATION messages with optional COUNTS only —
//     never tokens, cookies, request bodies, titles, or any PII.
//   - Steps log begin / summary / notable-transition, NOT one entry per warmed
//     title, so a 500-title library pass adds a handful of entries — never a
//     re-render storm on an open /admin.
//   - The buffer is capped at SYNC_LOG_MAX (oldest trimmed first) so it can
//     never grow unbounded, and it persists to localStorage so the log
//     survives a reload while an admin is debugging.

import { useSyncExternalStore } from "react";

export type SyncLogType = "info" | "error";

export interface SyncLogEntry {
  id: number;
  at: number; // epoch ms (UTC); formatted to local time only at render
  type: SyncLogType;
  message: string;
}

export const SYNC_LOG_MAX = 200;
const STORAGE_KEY = "showustv-sync-log";

let seq = 0;
let entries: SyncLogEntry[] = load();
const listeners = new Set<() => void>();

function load(): SyncLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (e): e is SyncLogEntry =>
        !!e && typeof e.id === "number" && typeof e.at === "number" && typeof e.message === "string"
    );
    // Keep the id sequence monotonic across reloads so React keys stay unique.
    for (const e of valid) if (e.id >= seq) seq = e.id + 1;
    return valid.slice(0, SYNC_LOG_MAX);
  } catch {
    return []; // no/blocked localStorage (private mode) — in-memory log still works
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full/unavailable — the in-memory log keeps working
  }
}

// Append one entry. Newest-first, capped at SYNC_LOG_MAX (oldest trimmed).
// Safe to call from any sync step; never throws. Keep messages to operation
// names + counts — no sensitive data.
export function logSync(message: string, type: SyncLogType = "info"): void {
  entries = [{ id: seq++, at: Date.now(), type, message }, ...entries].slice(0, SYNC_LOG_MAX);
  persist();
  listeners.forEach((l) => l());
}

export function clearSyncLog(): void {
  if (entries.length === 0) return;
  entries = [];
  persist();
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

// Cross-tab: another tab's sync (or a Clear) rewrites the shared localStorage
// key. Mirror it so an open /admin reflects every tab and a Clear propagates
// (rather than being resurrected). Best-effort — two tabs appending at the
// same instant are last-writer-wins, which is fine for a debug log. A null key
// means the whole store was cleared (localStorage.clear()); reload then too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    entries = load();
    listeners.forEach((l) => l());
  });
}

// Newest-first snapshot; the reference is stable between appends, so
// useSyncExternalStore only re-renders when the log actually changes.
export function useSyncLog(): SyncLogEntry[] {
  return useSyncExternalStore(subscribe, () => entries);
}
