// Outbound email. Provider-optional: with RESEND_API_KEY set (wrangler
// secret put) mail goes out via Resend. Without it, delivery FAILS CLOSED
// unless DEV_MAIL_LOG=1 (set in .dev.vars, never in production) explicitly
// opts into logging the message to the console — which is what local dev
// wants: wrangler dev prints the verification link to click. A false return
// means "not delivered"; callers must surface that, not pretend.

import type { Env } from "../env";

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    if (env.DEV_MAIL_LOG === "1") {
      console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
      return true;
    }
    console.error("email: RESEND_API_KEY not configured — refusing to drop mail silently");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM ?? "Show Us TV <noreply@showustv.com>",
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) console.error(`resend: ${res.status} ${await res.text()}`);
    return res.ok;
  } catch (e) {
    console.error("resend: send failed", e);
    return false;
  }
}

// Verification tokens are bearer credentials — only their digest is
// persisted, so a DB leak can't verify emails.
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
