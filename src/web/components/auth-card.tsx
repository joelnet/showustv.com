// The sign-in / create-account card: branding, both forms, and the mode
// toggle. Rendered by the /login page and embedded at the bottom of the
// marketing landing page, so the two are always the exact same card.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { post } from "../api";
import { useAuth, type User } from "../app";
import { SmpteBars, Wordmark } from "./ui";
import { IconClose } from "./icons";

export function AuthCard({
  initialMode = "login",
  close = false,
}: {
  initialMode?: "login" | "register";
  close?: boolean;
}) {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = { password: fd.get("password") as string };
    if (mode === "register") {
      body.email = fd.get("email") as string;
      body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
      body.login = fd.get("login") as string;
    }
    try {
      const d = await post(`/auth/${mode}`, body);
      const user = d.user as User;
      setUser(user);
      // A brand-new account goes straight to the preferences step (issue
      // #160). Shell's onboarded guard would bounce it there from "/"
      // anyway — going direct just skips the flash. Sign-ins land on "/"
      // as before (and an unfinished signup still gets re-routed by Shell).
      // The create form can also sign in an existing account (issue #174):
      // its payload carries `onboarded`, so route on that — an onboarded
      // user lands on "/" like a normal sign-in, never back in onboarding.
      navigate(mode === "register" && user.onboarded === false ? "/welcome" : "/", { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === "register";

  return (
    <div className="login-card">
      {close && (
        <Link to="/" className="login-close" aria-label="Back to home">
          <IconClose size={18} />
        </Link>
      )}
      <Wordmark />
      <SmpteBars />
      <p className="login-tag">Keeps Track of Our TV Shows (and Movies)</p>
      <form onSubmit={submit}>
        {registering ? (
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
        ) : (
          <label>
            Email or username
            <input name="login" autoComplete="username" required />
          </label>
        )}
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            required
            minLength={8}
          />
        </label>
        {registering ? (
          <p className="login-hint">You&rsquo;ll pick your username on the next step.</p>
        ) : (
          <Link to="/forgot-password" className="login-forgot">
            Forgot password?
          </Link>
        )}
        {error && <p className="error-note">{error}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {registering ? "Create account" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setMode(registering ? "login" : "register");
          setError(null);
        }}
      >
        {registering ? "Have an account? Sign in" : "New here? Create an account"}
      </button>
    </div>
  );
}
