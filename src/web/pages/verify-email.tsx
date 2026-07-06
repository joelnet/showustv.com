// Landing page for the emailed verification link (issue #13). Public route:
// the clicker may be logged out or on a different device — the token is the
// proof. Deliberately does nothing on load; the token is consumed only by
// the button press, so mail scanners prefetching the link can't verify an
// address the mailbox owner never confirmed.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { post } from "../api";
import { Wordmark } from "../components/ui";

const RESULT_MSG: Record<string, string> = {
  verified: "Email verified ✓. You're all set.",
  expired: "This verification link has expired. Send a fresh one from your settings.",
  invalid: "This verification link isn't valid. Send a fresh one from your settings.",
  taken: "That email address was verified by another account in the meantime.",
};

export function VerifyEmailPage() {
  const token = useSearchParams()[0].get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(token ? null : "invalid");

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await post("/auth/verify-email", { token });
      setResult(r.status);
    } catch {
      setResult("invalid");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="verify-email-page">
      <Wordmark />
      <h1>Confirm your email</h1>
      {result ? (
        <>
          <p className={result === "verified" ? "email-flag is-ok" : "email-flag"}>{RESULT_MSG[result] ?? RESULT_MSG.invalid}</p>
          {result === "verified" ? (
            <Link className="btn" to="/profile">
              Go to your profile
            </Link>
          ) : (
            // A failed verification needs the resend flow, which now lives on
            // Settings (issue #55) — send them there rather than to the profile.
            <Link className="btn" to="/settings">
              Go to settings
            </Link>
          )}
        </>
      ) : (
        <>
          <p className="email-flag">Press the button to verify this email address for your Show Us TV account.</p>
          <button className="btn" onClick={confirm} disabled={busy}>
            Confirm email
          </button>
        </>
      )}
    </div>
  );
}
