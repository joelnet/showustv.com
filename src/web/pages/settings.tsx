import { startTransition, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, put } from "../api";
import { useApi } from "../hooks";
import { clearQueue } from "../offline";
import { useAuth } from "../app";
import { ErrorNote } from "../components/ui";
import { IconCheck } from "../components/icons";
import { PushToggle } from "../components/push-toggle";
import { isIos, isStandalone } from "../pwa";
import { pushSupported, disablePush } from "../notifications";

interface EmailData {
  email: string | null;
  emailVerified: boolean;
  pendingEmail: string | null;
}

// Email verification (issue #13): enter an address, click the emailed link,
// confirm on the landing page, get the check mark. A verified email is what
// unlocks commenting. Lives on Settings alongside the rest of account
// identity (issue #55).
function EmailVerification({ data, reload }: { data: EmailData; reload: () => void }) {
  const verified = data.emailVerified && !!data.email;
  // A pending change takes precedence: seed the input with the pending address
  // so "Resend link" targets it (issues #56/#57). A settled verified address
  // (no pending change) stays empty — it's never re-validated unless the user
  // opts in via "Change email". Otherwise seed from the current unvalidated one.
  const [email, setEmail] = useState(data.pendingEmail ?? (verified ? "" : data.email ?? ""));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Only relevant when already verified: the input stays hidden behind a
  // "Change email" affordance so a settled address is never re-validated.
  const [changing, setChanging] = useState(false);
  // Re-authentication (issue #358): moving an ALREADY-VERIFIED address requires
  // the account password, so a hijacked session can't silently change the email.
  // First-time verification (no verified address yet) needs no password.
  const needsPassword = data.emailVerified;
  const [password, setPassword] = useState("");

  const send = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await post("/profile/email", needsPassword ? { email: email.trim(), password } : { email: email.trim() });
      setNote(`Verification link sent to ${email.trim()}. Check your inbox.`);
      setPassword("");
      // Success starts a fresh pending verification (reload surfaces it). Fold
      // the change form away so the new pending state — not a stale open input —
      // is what the user sees.
      setChanging(false);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const openChange = () => {
    setEmail("");
    setPassword("");
    setNote(null);
    setErr(null);
    setChanging(true);
  };

  const cancelChange = () => {
    setEmail("");
    setPassword("");
    setErr(null);
    setChanging(false);
  };

  const emailForm = (label: string) => (
    <form
      className={needsPassword ? "email-form has-password" : "email-form"}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        aria-label="Email address"
        autoFocus={changing}
        required
      />
      {needsPassword && (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Current password"
          aria-label="Current password"
          autoComplete="current-password"
          required
        />
      )}
      <button type="submit" className="btn" disabled={busy || !email.trim() || (needsPassword && !password)}>
        {label}
      </button>
    </form>
  );

  return (
    <>
      {data.pendingEmail ? (
        // A change is in flight (issue #57): present the NEW address as the one
        // awaiting validation — never the old validated address alongside it.
        // The form still lets the user resend to the pending address (or retarget
        // to a different one), so this isn't a dead end. There's already a change
        // in progress, so no "Change email" toggle is offered here.
        <>
          <p className="email-status">
            Verification pending for {data.pendingEmail}. Click the link in your inbox.
          </p>
          {emailForm(email.trim() === data.pendingEmail ? "Resend link" : "Verify")}
        </>
      ) : verified ? (
        // Settled, validated address with no pending change. The input stays
        // hidden behind "Change email" so a settled address is never re-validated.
        <>
          <p className="email-status">
            <span className="email-address">{data.email}</span>
            <span className="email-badge">
              <IconCheck size={13} /> Validated
            </span>
          </p>
          {changing ? (
            <div className="email-change">
              {emailForm("Send verification link")}
              <button type="button" className="link-btn" onClick={cancelChange} disabled={busy}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="link-btn" onClick={openChange}>
              Change email
            </button>
          )}
        </>
      ) : (
        // First-time verification, no pending change.
        <>
          <p className="email-status">Not validated. Verify your email to comment and vote.</p>
          {emailForm("Verify")}
        </>
      )}
      {note && <p className="email-note">{note}</p>}
      {err && <p className="email-err">{err}</p>}
    </>
  );
}

interface NotificationPrefs {
  followWatch: boolean;
  followComment: boolean;
  trackedComment: boolean;
  followFavorite: boolean;
  newFollower: boolean;
  listCreated: boolean;
  pushPublicKey: string | null;
}

// Notification settings (issues #129/#141): the per-type toggles plus the
// Web Push opt-in for this device (shared with the notifications page —
// components/push-toggle.tsx). Push is layered on top — the in-app type
// toggles gate whether the notification exists at all, push only changes
// whether this device buzzes about it.
function NotificationSettings({ prefs, reload }: { prefs: NotificationPrefs; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const supported = pushSupported();

  // One toggle per notification type; the PUT takes just the flipped key.
  const togglePref = async (patch: {
    followWatch?: boolean;
    followComment?: boolean;
    trackedComment?: boolean;
    followFavorite?: boolean;
    newFollower?: boolean;
    listCreated?: boolean;
  }) => {
    setBusy(true);
    setErr(null);
    try {
      await put("/notifications/prefs", patch);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  // iOS Safari only exposes push inside an installed (home-screen) app.
  const iosNeedsInstall = !supported && isIos() && !isStandalone();

  return (
    <>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.newFollower}
          disabled={busy}
          onChange={() => togglePref({ newFollower: !prefs.newFollower })}
        />
        <span>
          Someone followed you
          <span className="settings-hint">
            Get a notification when another user follows you, with a chance to follow back.
          </span>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.followWatch}
          disabled={busy}
          onChange={() => togglePref({ followWatch: !prefs.followWatch })}
        />
        <span>
          Someone you follow watched a show
          <span className="settings-hint">Get a notification when people you follow watch shows and movies.</span>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.followFavorite}
          disabled={busy}
          onChange={() => togglePref({ followFavorite: !prefs.followFavorite })}
        />
        <span>
          Someone you follow favorited a show
          <span className="settings-hint">Get a notification when people you follow favorite shows and movies.</span>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.listCreated}
          disabled={busy}
          onChange={() => togglePref({ listCreated: !prefs.listCreated })}
        />
        <span>
          Someone you follow created a list
          <span className="settings-hint">
            Get a notification when people you follow publish a new list on their profile.
          </span>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.followComment}
          disabled={busy}
          onChange={() => togglePref({ followComment: !prefs.followComment })}
        />
        <span>
          Someone you follow commented on a show you track
          <span className="settings-hint">
            Get a notification when people you follow comment on shows and movies in your library.
          </span>
        </span>
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.trackedComment}
          disabled={busy}
          onChange={() => togglePref({ trackedComment: !prefs.trackedComment })}
        />
        <span>
          Anyone commented on a show you track
          <span className="settings-hint">
            Get a notification when any user comments on shows and movies in your library.
          </span>
        </span>
      </label>

      {!prefs.pushPublicKey ? (
        <p className="settings-hint">Push notifications aren't available yet. Check back soon.</p>
      ) : !supported ? (
        <p className="settings-hint">
          {iosNeedsInstall
            ? "To get push notifications on iPhone or iPad, add the app to your home screen first."
            : "This browser doesn't support push notifications."}
        </p>
      ) : (
        <PushToggle publicKey={prefs.pushPublicKey} />
      )}
      {err && <ErrorNote message={err} />}
    </>
  );
}

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [tz, setTz] = useState(user!.tz);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Email lives on the auth User only as a bare `emailVerified` flag, so pull
  // the address and any pending verification from /profile (issue #55).
  const { data: emailData, error: emailError, reload: reloadEmail } = useApi<EmailData>("/profile");
  const { data: notifPrefs, error: notifError, reload: reloadNotifPrefs } = useApi<NotificationPrefs>("/notifications/prefs");

  const zones: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? [user!.tz, "UTC"];

  async function save() {
    setBusy(true);
    try {
      await put("/auth/settings", { tz });
      setUser({ ...user!, tz });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <h1 className="page-title">Settings</h1>
      <p className="settings-user">
        Signed in as <strong>{user!.username}</strong>
      </p>

      <label className="settings-field">
        Timezone
        <span className="settings-hint">Air dates and “Today” are judged in this timezone.</span>
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
      </label>
      <button className="btn" onClick={save} disabled={busy || tz === user!.tz}>
        {saved ? "Saved ✓" : "Save changes"}
      </button>

      <hr className="settings-rule" />
      <h2 className="settings-subtitle">Email</h2>
      {emailError ? (
        <ErrorNote message={emailError} />
      ) : emailData ? (
        <EmailVerification data={emailData} reload={reloadEmail} />
      ) : (
        <p className="settings-hint">Loading…</p>
      )}

      <hr className="settings-rule" />
      <h2 className="settings-subtitle">Notifications</h2>
      {notifError ? (
        <ErrorNote message={notifError} />
      ) : notifPrefs ? (
        <NotificationSettings prefs={notifPrefs} reload={reloadNotifPrefs} />
      ) : (
        <p className="settings-hint">Loading…</p>
      )}

      <hr className="settings-rule" />
      <h2 className="settings-subtitle">Import</h2>
      <p className="settings-hint">
        Moving over from TV Time? Upload your GDPR export zip and bring your shows, watch history and movies with
        you.
      </p>
      <Link className="btn btn-ghost" to="/settings/import">
        Import from TV Time
      </Link>

      {/* Admin entry point (issue #275), for admins only. Hiding it here is
          cosmetic — the /admin page redirects non-admins and every
          /api/admin endpoint re-checks is_admin server-side. */}
      {user!.isAdmin && (
        <>
          <hr className="settings-rule" />
          <h2 className="settings-subtitle">Admin</h2>
          <p className="settings-hint">Site administration tools. Only admins can see this.</p>
          <Link className="btn btn-ghost" to="/admin">
            Open admin page
          </Link>
        </>
      )}

      <hr className="settings-rule" />
      <button
        className="btn btn-ghost"
        onClick={async () => {
          // Unsynced offline changes belong to this session — they must not
          // replay into whoever signs in next on this browser.
          await clearQueue();
          // Neither may this device's push subscription: it belongs to the
          // account, and a shared computer must stop getting its watch
          // notifications the moment it signs out. Best-effort — an offline
          // sign-out just leaves it for the next sign-in to reuse.
          await disablePush().catch(() => {});
          // The server logout needs the network, but the local sign-out must
          // happen regardless — otherwise an offline sign-out leaves the cached
          // identity behind for the next person to restore on a refresh (#51).
          await post("/auth/logout").catch(() => {});
          // Clear the user AND route home in one transition. react-router's
          // <BrowserRouter> wraps location updates in React.startTransition, so
          // navigate("/") is a low-priority update while a bare setUser(null) is
          // urgent. Committed separately, the urgent user=null render happens
          // while we're still on /settings — <Shell>'s `if (!user)` guard then
          // fires <Navigate to="/login">, which beats the pending "/" transition
          // and strands sign-out on /login (issue #34). Batching both into the
          // same transition commits user=null and location="/" together, so the
          // logged-out "/" route (Landing/Login) matches and Shell never renders.
          startTransition(() => {
            setUser(null);
            navigate("/", { replace: true });
          });
        }}
      >
        Sign out
      </button>
    </div>
  );
}
