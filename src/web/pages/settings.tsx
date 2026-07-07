import { startTransition, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, put } from "../api";
import { useApi } from "../hooks";
import { clearQueue } from "../offline";
import { useAuth } from "../app";
import { ErrorNote } from "../components/ui";
import { IconCheck } from "../components/icons";

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

  const send = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await post("/profile/email", { email: email.trim() });
      setNote(`Verification link sent to ${email.trim()}. Check your inbox.`);
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
    setNote(null);
    setErr(null);
    setChanging(true);
  };

  const cancelChange = () => {
    setEmail("");
    setErr(null);
    setChanging(false);
  };

  const emailForm = (label: string) => (
    <form
      className="email-form"
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
      <button type="submit" className="btn" disabled={busy || !email.trim()}>
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

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [tz, setTz] = useState(user!.tz);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Email lives on the auth User only as a bare `emailVerified` flag, so pull
  // the address and any pending verification from /profile (issue #55).
  const { data: emailData, error: emailError, reload: reloadEmail } = useApi<EmailData>("/profile");

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
      <h2 className="settings-subtitle">Import</h2>
      <p className="settings-hint">
        Moving over from TV Time? Upload your GDPR export zip and bring your shows, watch history and movies with
        you.
      </p>
      <Link className="btn btn-ghost" to="/settings/import">
        Import from TV Time
      </Link>

      <hr className="settings-rule" />
      <button
        className="btn btn-ghost"
        onClick={async () => {
          // Unsynced offline changes belong to this session — they must not
          // replay into whoever signs in next on this browser.
          await clearQueue();
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
