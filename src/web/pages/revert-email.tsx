// Landing page for the "your email was changed" security notice.
// Public route: the clicker's sessions were revoked by the change that prompted
// this notice, so they're logged out by definition — the token is the proof.
// Like /verify-email it does nothing on load; the token is consumed only by the
// button press, so a mail scanner prefetching the link can't revert anything.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { post } from "../api";
import { AccountPage } from "../components/auth-card";

const RESULT_MSG: Record<string, string> = {
  reverted: "Your email address has been restored ✓, and every other session has been signed out. Sign in to continue.",
  expired: "This link has expired. If you still don't recognize the change, reset your password to secure your account.",
  invalid: "This link isn't valid — it may have already been used. If you still don't recognize the change, reset your password to secure your account.",
  taken: "Your previous email address is now in use by another account, so it couldn't be restored. Reset your password to secure your account.",
};

export function RevertEmailPage() {
  const token = useSearchParams()[0].get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(token ? null : "invalid");

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await post("/auth/revert-email", { token });
      setResult(r.status);
    } catch {
      setResult("invalid");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountPage title="Restore your email">
      {result ? (
        <>
          <p className={result === "reverted" ? "login-tag email-flag is-ok" : "error-note"}>
            {RESULT_MSG[result] ?? RESULT_MSG.invalid}
          </p>
          {result === "reverted" ? (
            <Link className="btn" to="/login">
              Sign in
            </Link>
          ) : (
            <Link className="btn" to="/forgot-password">
              Reset password
            </Link>
          )}
        </>
      ) : (
        <>
          <p className="login-tag">
            Didn&rsquo;t change your email? Press the button to restore your previous address and sign every other
            session out of your account.
          </p>
          <button className="btn" onClick={confirm} disabled={busy}>
            Restore my email
          </button>
        </>
      )}
    </AccountPage>
  );
}
