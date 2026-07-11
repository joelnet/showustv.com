// Forgot-password flow (issue #216). Two public pages: /forgot-password asks
// for the account email and always gets the same generic confirmation (the
// server never says whether the address has an account), and /reset-password
// is where the emailed link lands. Like /verify-email, the reset page does
// nothing on load — the token is consumed only when the user submits the new
// password, so mail scanners prefetching the link can't burn the token.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { post, ApiError } from "../api";
import { Wordmark } from "../components/ui";

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post("/auth/forgot", { email: new FormData(e.currentTarget).get("email") });
      setSent(true);
    } catch (err: any) {
      setError(err.message); // bad address format, rate limit, or offline
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Wordmark />
        <h1 className="login-form-title">Reset your password</h1>
        {sent ? (
          <>
            {/* Deliberately the same message whether or not the email has an
                account — mirrors the server's non-enumerating response. */}
            <p className="login-tag">
              If an account exists for that email address, a reset link is on its way. It expires in 30 minutes —
              check your spam folder if it doesn&rsquo;t arrive.
            </p>
            <Link className="btn" to="/login">
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <p className="login-tag">Enter your account&rsquo;s email address and we&rsquo;ll send you a reset link.</p>
            <form onSubmit={submit}>
              <label>
                Email
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
              </label>
              {error && <p className="error-note">{error}</p>}
              <button className="btn" type="submit" disabled={busy}>
                Send reset link
              </button>
            </form>
            <Link className="link-btn" to="/login">
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

const RESULT_MSG: Record<string, string> = {
  expired: "This reset link has expired. Request a fresh one below.",
  invalid: "This reset link isn't valid — it may have already been used. Request a fresh one below.",
};

export function ResetPasswordPage() {
  const token = useSearchParams()[0].get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "ok" | "expired" | "invalid" once the server has answered; a missing
  // token short-circuits to invalid without spending a request.
  const [result, setResult] = useState<string | null>(token ? null : "invalid");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await post("/auth/reset", { token, password: new FormData(e.currentTarget).get("password") });
      setResult(r.status);
    } catch (err: any) {
      // 400 (password rules), 429, offline — recoverable, keep the form up.
      if (err instanceof ApiError && err.status > 0) setError(err.message);
      else setError("Something went wrong. Please try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Wordmark />
        <h1 className="login-form-title">Choose a new password</h1>
        {result === "ok" ? (
          <>
            <p className="login-tag">Password updated ✓. Sign in with your new password.</p>
            <Link className="btn" to="/login">
              Sign in
            </Link>
          </>
        ) : result ? (
          <>
            <p className="error-note">{RESULT_MSG[result] ?? RESULT_MSG.invalid}</p>
            <Link className="btn" to="/forgot-password">
              Request a new link
            </Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} />
            </label>
            {error && <p className="error-note">{error}</p>}
            <button className="btn" type="submit" disabled={busy}>
              Set new password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
