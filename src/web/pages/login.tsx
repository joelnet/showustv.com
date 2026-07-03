import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { post } from "../api";
import { useAuth, type User } from "../app";
import { SmpteBars, Wordmark } from "../components/ui";

export function Login() {
  const { user, setUser, siteOpen } = useAuth();
  const navigate = useNavigate();
  // The landing page links to /login?mode=register for its sign-up CTAs.
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(
    params.get("mode") === "register" ? "register" : "login"
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // While the site is closed, registering joins the wait list — the account is
  // created but can't sign in yet, so show a confirmation instead of routing in.
  const [joined, setJoined] = useState(false);

  if (user) {
    navigate("/", { replace: true });
    return null;
  }

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
      if (d.waitlisted) {
        setJoined(true);
        return;
      }
      setUser(d.user as User);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === "register";
  const joinMode = registering && !siteOpen; // "join the wait list" instead of "create account"

  if (joined) {
    return (
      <div className="login-page">
        <div className="login-card">
          <Wordmark />
          <SmpteBars />
          <h1 className="login-joined-title">You&rsquo;re on the list ✓</h1>
          <p className="login-tag">
            Show Us TV isn&rsquo;t open to everyone just yet. We&rsquo;ve saved your spot — we&rsquo;ll email you the
            moment you can sign in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Wordmark />
        <SmpteBars />
        <p className="login-tag">
          {joinMode
            ? "We're not open to everyone yet — join the wait list and we'll email you when you can sign in."
            : "Keep track of every show and movie you watch."}
        </p>
        <form onSubmit={submit}>
          {mode === "register" ? (
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
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={8}
            />
          </label>
          {registering && (
            <p className="login-hint">You&rsquo;ll get a random username you can change anytime on your profile.</p>
          )}
          {error && <p className="error-note">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            {!registering ? "Sign in" : joinMode ? "Join the wait list" : "Create account"}
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
          {registering ? "Have an account? Sign in" : siteOpen ? "New here? Create an account" : "Want in? Join the wait list"}
        </button>
      </div>
    </div>
  );
}
