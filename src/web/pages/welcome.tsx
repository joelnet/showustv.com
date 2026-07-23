// The secondary signup step. Right after creating an account
// the user lands here — stage 2 of 2, "Preferences" — to confirm the two
// things the app already picked for them: the auto-assigned username (the
// register handle algorithm; it arrives on the auth user, so this screen
// never re-derives it) and their timezone, defaulted to what the browser
// detects. Both fields are valid as prefilled, so "Finish Signup" is a
// single frictionless click that drops them into Search to add their first
// shows. Same card styling as the login / create-account box.
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { post } from "../api";
import { useAuth } from "../app";
import { SmpteBars, Wordmark } from "../components/ui";

export function WelcomePage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  // Register already stored the detected zone, so user.tz normally IS this
  // value — detecting again keeps the default honest if the account was
  // created on another device (or the tz save fell back to UTC).
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [username, setUsername] = useState(user?.username ?? "");
  const [tz, setTz] = useState(detected || user?.tz || "UTC");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return <Navigate to="/login" replace />;
  // Already set up (returning user typing the URL, or a mid-signup reload
  // that raced /auth/me): straight into the app, never back through here.
  if (user.onboarded !== false) return <Navigate to="/" replace />;

  // Same timezone control as Settings. The detected zone must always be an
  // option, even on the rare runtime without supportedValuesOf.
  const zones: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? ["UTC"];
  if (!zones.includes(tz)) zones.unshift(tz);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await post("/auth/onboarding", { username: username.trim(), tz });
      setUser({ ...user!, username: d.username, tz: d.tz, onboarded: true });
      // A fresh account has nothing to watch yet, so land on Search — the
      // first job is finding some shows and movies to add.
      navigate("/search", { replace: true });
    } catch (err: any) {
      // Inline server errors: the username-taken race (409) or a shape the
      // input attributes didn't catch. The prefilled defaults never hit this.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Wordmark />
        <SmpteBars />
        <p className="login-tag">Almost there. Check your details and jump in.</p>
        <div className="signup-progress">
          <div
            className="signup-progress-track"
            role="progressbar"
            aria-valuenow={50}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Signup progress"
          >
            <span className="signup-progress-fill" />
          </div>
          <ol className="signup-progress-steps">
            <li className="is-done">Sign up ✓</li>
            <li className="is-current" aria-current="step">
              Preferences
            </li>
          </ol>
        </div>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              minLength={3}
              maxLength={20}
              pattern="[A-Za-z0-9_]+"
              title="3 to 20 letters, digits, or _"
              autoComplete="username"
              required
            />
          </label>
          <label>
            Timezone
            <select value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <p className="login-hint">Both look good as they are. You can change them anytime in your profile and settings.</p>
          {error && <p className="error-note">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            Finish Signup
          </button>
        </form>
      </div>
    </div>
  );
}
