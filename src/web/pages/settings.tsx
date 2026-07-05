import { startTransition, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post, put } from "../api";
import { clearQueue } from "../offline";
import { useAuth } from "../app";
import { useInstallPrompt } from "../pwa";
import { InstallAppButton } from "../components/install";

export function SettingsPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [tz, setTz] = useState(user!.tz);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const install = useInstallPrompt();

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
      <h2 className="settings-subtitle">Import</h2>
      <p className="settings-hint">
        Moving over from TV Time? Upload your GDPR export zip and bring your shows, watch history and movies with
        you.
      </p>
      <Link className="btn btn-ghost" to="/settings/import">
        Import from TV Time
      </Link>

      {install.available && (
        <>
          <hr className="settings-rule" />
          <h2 className="settings-subtitle">Install app</h2>
          <p className="settings-hint">
            Put Show Us TV on your home screen — it opens full screen, like a native app.
          </p>
          <InstallAppButton buttonClass="btn btn-ghost" />
        </>
      )}

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
