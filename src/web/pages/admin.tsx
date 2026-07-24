// Admin page: site-wide admin tools that aren't tied to one
// profile (those live in AdminTools on profile pages). Linked from
// Settings for admins only. The render gate below is UX, not security — a
// non-admin who types /admin just lands back home; every /api/admin endpoint
// re-checks users.is_admin server-side (routes/admin.ts) and answers an
// indistinguishable 404 to anyone else.
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, post, put, ApiError } from "../api";
import { useAuth } from "../app";
import { useToast } from "../components/toast";
import { pushSupported, refreshUnread } from "../notifications";
import { isStandalone } from "../pwa";
import { useSyncLog, clearSyncLog, SYNC_LOG_MAX, type SyncLogEntry } from "../synclog";

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

      <DiscordWebhook />

      <AutoFollow />

      <SyncLogView />

      <PushDiagnostics />
    </div>
  );
}

// Discord webhook config (issue #8): stores an admin-set webhook URL
// plus a notify-on-new-signups flag (server side: /api/admin/discord →
// app_settings). When both are set, POST /register fires a Discord message
// for each new signup — this replaced the external notify-new-users.mjs
// cron. The server rejects any URL that isn't a real Discord webhook
// (https://discord.com/api/webhooks/…), so a save can fail validation; that
// message surfaces in the error toast.
function DiscordWebhook() {
  const toast = useToast();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [notifySignups, setNotifySignups] = useState(false);
  // Editing is blocked until the current values load — saving blind
  // would silently overwrite the stored config with defaults.
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ webhookUrl: string; notifySignups: boolean }>("/admin/discord")
      .then((d) => {
        setWebhookUrl(d.webhookUrl);
        setNotifySignups(d.notifySignups);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await put("/admin/discord", { webhookUrl: webhookUrl.trim(), notifySignups });
      toast("Discord settings saved");
    } catch (e) {
      toast(e instanceof ApiError && e.status === 400 ? e.message : "Couldn't save the Discord settings", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 className="settings-subtitle">Discord webhook</h2>
      <p className="settings-hint">
        Webhook the site posts to (server-created Discord messages, e.g. new-signup pings). Must be a Discord
        webhook URL; leave empty to turn Discord posting off.
      </p>
      {state === "error" ? (
        <p className="error-note">Couldn't load the Discord settings — reload to try again.</p>
      ) : (
        <>
          {/* Bare labels have no layout on this page; mirror .login-card label. */}
          <label
            style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "var(--muted)", maxWidth: "480px", margin: "10px 0 14px" }}
          >
            Webhook URL
            <input
              type="url"
              placeholder="https://discord.com/api/webhooks/…"
              maxLength={400}
              value={webhookUrl}
              disabled={state !== "ready" || saving}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={notifySignups}
              disabled={state !== "ready" || saving}
              onChange={() => setNotifySignups((v) => !v)}
            />
            <span>
              Notify on new user signups
              <span className="settings-hint">
                Post a message to the webhook each time a new account is created.
              </span>
            </span>
          </label>
          <button className="btn" onClick={save} disabled={state !== "ready" || saving}>
            {saving ? "Saving…" : "Save Discord settings"}
          </button>
        </>
      )}
    </>
  );
}

// Signup auto-follow config (issues #11/#14): which account every new
// signup starts out silently following (server side: /api/admin/auto-follow
// → app_settings). Empty = feature off. The save never rejects a name for
// not existing — signups resolve it live — but the response flags an
// unknown name (exists: false) so the toast can warn instead of implying
// the follow is active.
function AutoFollow() {
  const toast = useToast();
  const [username, setUsername] = useState("");
  // Editing is blocked until the current value loads — saving blind
  // would silently overwrite the stored config with an empty box.
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ username: string }>("/admin/auto-follow")
      .then((d) => {
        setUsername(d.username);
        setState("ready");
      })
      .catch(() => setState("error"));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const d: { username: string; exists: boolean } = await put("/admin/auto-follow", { username });
      setUsername(d.username); // server-normalized: trimmed, leading @ stripped
      if (d.username === "") toast("Auto-follow turned off");
      else if (!d.exists) toast(`Saved, but no account is named ${d.username} — new signups won't follow anyone`, "error");
      else toast(`New signups will follow ${d.username}`);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 400 ? e.message : "Couldn't save the auto-follow username", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 className="settings-subtitle">Auto-follow on signup</h2>
      <p className="settings-hint">
        New accounts automatically follow this user (silently — they get no notification), so a fresh account's
        following list isn't empty. Leave empty to turn auto-follow off.
      </p>
      {state === "error" ? (
        <p className="error-note">Couldn't load the auto-follow setting — reload to try again.</p>
      ) : (
        <>
          {/* Bare labels have no layout on this page; mirror .login-card label. */}
          <label
            style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "var(--muted)", maxWidth: "480px", margin: "10px 0 14px" }}
          >
            Auto-follow username (new signups)
            <input
              type="text"
              placeholder="username"
              maxLength={21}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              disabled={state !== "ready" || saving}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <button className="btn" onClick={save} disabled={state !== "ready" || saving}>
            {saving ? "Saving…" : "Save auto-follow"}
          </button>
        </>
      )}
    </>
  );
}

// Live view of the background sync the header progress bar
// reflects: the library and Continue Watching precache passes
// (precache.ts) and the offline mutation-queue replay (offline.ts) append to a
// small capped client log store (synclog.ts) as they work; this renders it
// newest-first and updates in place while a sync runs. Admin-only by virtue of
// living on this already-gated page. The store keeps operation names + counts
// only — no tokens, bodies, or title names — so nothing sensitive surfaces.
function SyncLogView() {
  const entries = useSyncLog();
  return (
    <>
      <h2 className="settings-subtitle">Sync logs</h2>
      <p className="settings-hint">
        Live log of the background sync the header progress bar reflects — the library and Continue
        Watching precache passes and the offline queue replay. Newest first; the last {SYNC_LOG_MAX}{" "}
        entries are kept (across reloads).
      </p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "8px" }}>
        <span className="settings-hint" style={{ margin: 0 }}>
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
        <button className="btn btn-ghost" onClick={clearSyncLog} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="settings-hint">
          No sync activity recorded yet. Browse the app, or toggle offline and back online, to see entries here.
        </p>
      ) : (
        <div
          role="log"
          aria-live="polite"
          style={{
            maxHeight: "320px",
            overflowY: "auto",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius, 8px)",
            background: "var(--surface)",
            padding: "8px 10px",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "12px",
            lineHeight: 1.6,
          }}
        >
          {entries.map((e) => (
            <SyncLogLine key={e.id} entry={e} />
          ))}
        </div>
      )}
    </>
  );
}

// Date + time — entries persist across reloads, so activity from different
// days must stay distinguishable. Rendered in the viewer's local zone.
const logTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function SyncLogLine({ entry }: { entry: SyncLogEntry }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: entry.type === "error" ? "var(--red)" : undefined }}>
      <span style={{ opacity: 0.6 }}>{logTimeFmt.format(entry.at)}</span> {entry.message}
    </div>
  );
}

// TEMP DEBUG: step-by-step Web Push probe for the Android PWA toggle wedge.
// The installed app has no devtools, so each stage reports its outcome and
// timing on screen. Runs the same direct PushManager flow as enablePush()
// (src/web/notifications.ts), preserving the button tap through subscribe(),
// and really subscribes this device when every stage passes. Self-contained on
// purpose (including the urlBase64ToUint8Array copy) so removal is deleting
// this block.
// REMOVE AFTER DIAGNOSIS.

const fmtErr = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const tail = (s: string) => `…${s.slice(-32)}`;
type NavigatorWithUAData = Navigator & {
  userAgentData?: {
    getHighEntropyValues: (hints: string[]) => Promise<Record<string, unknown>>;
  };
};

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
      const appKey = urlBase64ToUint8Array(key);
      add(`VAPID public key bytes: length=${appKey.length} first=${appKey[0] ?? "n/a"}`);
      if (appKey.length !== 65 || appKey[0] !== 4) {
        add("x VAPID public key is invalid; expected a 65-byte uncompressed P-256 public key starting with 4");
        return;
      }

      // Do only the work required to locate an existing subscription before
      // subscribe(). The previous diagnostic spent 15 seconds awaiting a
      // requestPermission() probe first, so the button's transient user
      // activation had expired and a subsequent subscribe() result could not
      // distinguish a permission wedge from a missing user gesture.
      const reg = await step(
        "serviceWorker.ready",
        3_000,
        () => navigator.serviceWorker.ready,
        (r) => `active=${r.active?.state ?? "none"} waiting=${!!r.waiting} scope=${r.scope}`
      );
      if (!reg) return;
      const existing = await step(
        "getSubscription",
        3_000,
        () => reg.pushManager.getSubscription(),
        (s) =>
          s
            ? `endpoint ${tail(s.endpoint)} expires=${s.expirationTime == null ? "never" : new Date(s.expirationTime).toISOString()}`
            : "null"
      );
      if (!existing)
        add(
          `userActivation before subscribe: active=${navigator.userActivation?.isActive ?? "unsupported"} hasBeenActive=${navigator.userActivation?.hasBeenActive ?? "unsupported"}`
        );
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

      // The push service's own view can disagree with Notification.permission
      // on Android WebAPKs. Read it after subscribe so this diagnostic does not
      // spend any of the tap's activation budget before the operation that
      // needs it.
      const pushPermission = await step(
        "pushManager.permissionState",
        3_000,
        () => reg.pushManager.permissionState({ userVisibleOnly: true }),
        String
      );
      add(`Notification.permission after subscribe: ${Notification.permission}`);
      const uaData = (navigator as NavigatorWithUAData).userAgentData;
      if (uaData) {
        await step(
          "userAgentData",
          3_000,
          () => uaData.getHighEntropyValues(["platformVersion", "model", "fullVersionList"]),
          (v) => JSON.stringify(v)
        );
      }
      if (!sub && Notification.permission === "granted" && pushPermission === "granted") {
        if (isAppleStandalonePwa())
          add(
            "iOS reports notifications as granted, but refused to create the subscription. This is common in the iOS Simulator; verify on a physical iPhone, or reinstall the Home Screen app if this is a real device."
          );
        else
          add(
            "Browser permission is granted, but PushManager refused to create the subscription. Reset this site's notification permission or reinstall the app."
          );
      }
      if (!sub) return;
      const saved = await step("register with server", 10_000, () => post("/notifications/push/subscribe", sub.toJSON()), () => "ok");
      if (saved) add("done: this device is now subscribed; the settings toggle should read on");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <h2 className="settings-subtitle">Push diagnostics</h2>
      <p className="settings-hint">
        Temporary: tries the direct PushManager flow from this tap and reports each stage's outcome and timing. If
        every stage passes, this device ends up subscribed for real.
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
