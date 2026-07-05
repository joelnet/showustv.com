// Outbound email via the Cloudflare Email Service `send_email` binding (EMAIL).
// No API keys: the binding sends from any address on an onboarded domain. Local
// dev sets DISABLE_EMAIL_SEND=true (.dev.vars, never in production) to log the
// message — including the verification link — to the console instead of sending,
// which is what wrangler dev wants. Without the binding and not disabled,
// delivery FAILS CLOSED. A false return means "not delivered"; callers must
// surface that, not pretend.

import type { Env } from "../env";

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (env.DISABLE_EMAIL_SEND === "true") {
    console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return true;
  }
  if (!env.EMAIL) {
    console.error("email: EMAIL binding not configured — refusing to drop mail silently");
    return false;
  }
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM ?? "noreply@showustv.com", name: env.EMAIL_FROM_NAME ?? "Show Us TV" },
      subject,
      text,
    });
    return true;
  } catch (e) {
    console.error("email: send failed", e);
    return false;
  }
}

// Verification tokens are bearer credentials — only their digest is
// persisted, so a DB leak can't verify emails.
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
