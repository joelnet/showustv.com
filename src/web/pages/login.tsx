import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "../api";
import { useAuth, type User } from "../app";
import { SmpteBars, Wordmark } from "../components/ui";

export function Login() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    navigate("/", { replace: true });
    return null;
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const body: Record<string, string> = {
      username: fd.get("username") as string,
      password: fd.get("password") as string,
    };
    if (mode === "register") body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const d = await post(`/auth/${mode}`, body);
      setUser(d.user as User);
      navigate("/", { replace: true });
    } catch (err: any) {
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
        <p className="login-tag">Keep track of every show and movie you watch.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input name="username" autoComplete="username" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" />
          </label>
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
          {error && <p className="error-note">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
