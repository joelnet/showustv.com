// Admin page (issue #275): site-wide admin tools that aren't tied to one
// profile (those live in AdminTools on profile pages, issue #17). Linked from
// Settings for admins only. The render gate below is UX, not security — a
// non-admin who types /admin just lands back home; every /api/admin endpoint
// re-checks users.is_admin server-side (routes/admin.ts) and answers an
// indistinguishable 404 to anyone else.
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, post } from "../api";
import { useAuth } from "../app";
import { useToast } from "../components/toast";
import { pushSupported, refreshUnread } from "../notifications";
import { isStandalone } from "../pwa";

export function AdminPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!user?.isAdmin) return <Navigate to="/" replace />;

  const sendTest = async () => {
    setBusy(true);
    try {
      await post("/admin/test-notification");
      // The new row is unread by definition — refresh the bell badge now
      // instead of waiting for its next poll, so the test shows instantly.
      void refreshUnread();
      toast("Test notification sent");
    } catch {
      toast("Couldn't send the test notification", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <h1 className="page-title">Admin</h1>

      <h2 className="settings-subtitle">Notifications</h2>
      <p className="settings-hint">
        Sends yourself a test notification. It lands behind the bell, and pushes to any of your devices that have
        push notifications turned on.
      </p>
      <button className="btn" onClick={sendTest} disabled={busy}>
        {busy ? "Sending…" : "Send test notification"}
      </button>

      <PushDiagnostics />
    </div>
  );
}

// TEMP DEBUG: step-by-step Web Push probe for the Android PWA toggle wedge —
// enablePush() hangs with no error on that device and the installed app has
// no devtools, so each stage reports its outcome and timing on screen. Runs
// the same stages in the same order as enablePush() (src/web/notifications.ts)
// so a wedge lands on the same step, and if it gets all the way through it
// really subscribes this device. Self-contained on purpose (including the
// urlBase64ToUint8Array copy) so removal is deleting this block.
// REMOVE AFTER DIAGNOSIS.

const fmtErr = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const tail = (s: string) => `…${s.slice(-32)}`;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isAppleStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const appleMobile =
    /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return appleMobile && nav.standalone === true;
}

function PushDiagnostics() {
  // undefined = still fetching, null = push not configured/prefs unreachable.
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api<{ pushPublicKey: string | null }>("/notifications/prefs")
      .then((d) => setKey(d.pushPublicKey))
      .catch(() => setKey(null));
  }, []);

  const add = (s: string) => setLines((prev) => [...prev, s]);

  // Race one stage against a watchdog. A stage that outlives its watchdog is
  // reported as wedged but keeps a watcher attached, so "hung forever" and
  // "answered very late" are distinguishable in the log. Returns null on
  // timeout/rejection (already logged).
  async function step<T>(label: string, ms: number, fn: () => Promise<T>, show: (v: T) => string): Promise<T | null> {
    const start = performance.now();
    const dur = () => `${Math.round(performance.now() - start)}ms`;
    let p: Promise<T>;
    try {
      p = fn();
    } catch (e) {
      add(`✗ ${label} threw: ${fmtErr(e)}`);
      return null;
    }
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    );
    const winner = await Promise.race([
      settled,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
    ]);
    if (winner === "timeout") {
      add(`⏳ ${label}: no answer after ${dur()} — wedged (still watching for a late answer)`);
      void settled.then((w) =>
        add(w.ok ? `… ${label} answered late (${dur()}): ${show(w.v)}` : `… ${label} rejected late (${dur()}): ${fmtErr(w.e)}`)
      );
      return null;
    }
    if (!winner.ok) {
      add(`✗ ${label} rejected (${dur()}): ${fmtErr(winner.e)}`);
      return null;
    }
    add(`✓ ${label} (${dur()}): ${show(winner.v)}`);
    return winner.v;
  }

  const run = async () => {
    if (!key) return;
    setRunning(true);
    setLines([]);
    try {
      add(`ua: ${navigator.userAgent}`);
      add(`standalone=${isStandalone()} pushSupported=${pushSupported()} online=${navigator.onLine}`);
      add(`Notification.permission: ${Notification.permission}`);
      // Probe only — we do NOT gate on it. Mirroring the fixed enablePush():
      // when permission already reads "granted" we press on to (re)subscribe
      // even if this call wedges. A wedged probe paired with "granted" above
      // is exactly the pairing the fix targets — and the stages after it
      // still run, actually re-subscribing this device.
      const alreadyGranted = Notification.permission === "granted";
      const perm = await step("requestPermission (probe)", 15_000, () => Notification.requestPermission(), String);
      if (!alreadyGranted && perm !== "granted")
        add(
          `→ permission is "${perm ?? "unresolved"}", not "granted"; continuing anyway to see whether PushManager can recover`
        );
      if (alreadyGranted && perm !== "granted")
        add("→ permission was already granted; proceeding past the probe wedge (this is the fix path)");
      const reg = await step(
        "serviceWorker.ready",
        3_000,
        () => navigator.serviceWorker.ready,
        (r) => `active=${r.active?.state ?? "none"} waiting=${!!r.waiting} scope=${r.scope}`
      );
      if (!reg) return;
      // The push service's own view of permission — can disagree with
      // Notification.permission on Android WebAPKs, which is exactly the
      // delegation quirk this probe exists to catch.
      const pushPermission = await step(
        "pushManager.permissionState",
        3_000,
        () => reg.pushManager.permissionState({ userVisibleOnly: true }),
        String
      );
      const existing = await step(
        "getSubscription",
        3_000,
        () => reg.pushManager.getSubscription(),
        (s) =>
          s
            ? `endpoint ${tail(s.endpoint)} expires=${s.expirationTime == null ? "never" : new Date(s.expirationTime).toISOString()}`
            : "null"
      );
      const appKey = urlBase64ToUint8Array(key);
      add(`VAPID public key bytes: length=${appKey.length} first=${appKey[0] ?? "n/a"}`);
      if (appKey.length !== 65 || appKey[0] !== 4) {
        add("✗ VAPID public key is invalid; expected a 65-byte uncompressed P-256 public key starting with 4");
        return;
      }
      const sub =
        existing ??
        (await step(
          "pushManager.subscribe",
          20_000,
          () =>
            reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: appKey as unknown as BufferSource,
            }),
          (s) => `endpoint ${tail(s.endpoint)}`
        ));
      if (!sub && Notification.permission === "granted" && pushPermission === "granted") {
        if (isAppleStandalonePwa())
          add(
            "→ iOS reports notifications as granted, but refused to create the subscription. This is common in the iOS Simulator; verify on a physical iPhone, or reinstall the Home Screen app if this is a real device."
          );
        else
          add(
            "→ Browser permission is granted, but PushManager refused to create the subscription. Reset this site's notification permission or reinstall the app."
          );
      }
      if (!sub) return;
      const saved = await step("register with server", 10_000, () => post("/notifications/push/subscribe", sub.toJSON()), () => "ok");
      if (saved) add("done — this device is now subscribed; the settings toggle should read on");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <h2 className="settings-subtitle">Push diagnostics</h2>
      <p className="settings-hint">
        Temporary: runs the exact enable-push sequence one stage at a time and reports each stage's outcome and
        timing. If every stage passes, this device ends up subscribed for real.
      </p>
      <button className="btn" onClick={run} disabled={running || !key}>
        {running ? "Running…" : "Run push diagnostics"}
      </button>
      {key === null && <p className="settings-hint">Push isn't configured (no VAPID key from /notifications/prefs).</p>}
      {lines.length > 0 && (
        <>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "12px", lineHeight: 1.5 }}>
            {lines.join("\n")}
          </pre>
          <button
            className="btn btn-ghost"
            onClick={() => void navigator.clipboard.writeText(lines.join("\n")).catch(() => {})}
          >
            Copy results
          </button>
        </>
      )}
    </>
  );
}
