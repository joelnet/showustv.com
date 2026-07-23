// App-wide transient toast. Imperative, fire-and-forget, in the
// mold of celebration.tsx:
//
//   const toast = useToast();
//   toast("Your profile is now public");        // bottom-center, auto-dismisses
//   toast("Couldn't save that", "error");       // red-tinted variant
//
// Triggered from event handlers (not render), so it fires exactly once per
// call; a new call while one is showing replaces it and restarts the timer.
// Non-blocking (no actions, no focus trap) — for messages that need a button,
// see the update toast in app.tsx.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastKind = "ok" | "error";
type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export const useToast = () => useContext(ToastCtx);

const LIFETIME_MS = 3000;

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const seq = useRef(0);

  const show = useCallback<ToastFn>((message, kind = "ok") => {
    seq.current += 1;
    setToast({ id: seq.current, message, kind });
  }, []);

  // Auto-dismiss. `toast.id` in the deps means a second toast while one is
  // showing restarts the timer cleanly.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), LIFETIME_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        // Keyed remount per toast so the entrance animation replays even when
        // one message replaces another.
        <div key={toast.id} className={`toast${toast.kind === "error" ? " is-error" : ""}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
