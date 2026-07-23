// Email-verification dispatch, shared by register (a fresh signup
// verifies immediately) and the profile "add/change email" flow. Storing the
// pending address + token here, and only swapping users.email when the token is
// clicked (routes/auth.ts POST /verify-email), keeps a typo or an unverified
// third-party address from ever clobbering a verified one.

import type { Env } from "../env";
import { sendEmail, sha256Hex, brandedEmailHtml } from "./email";
import { nowIso } from "./dates";

export const VERIFY_TTL_MS = 24 * 3600 * 1000;

// Store (replacing any prior pending row) the verification for a user and mail
// the link. The raw token exists only in the email; the DB keeps its SHA-256
// digest, so a DB leak can't mint verifications. The link lands on the SPA
// confirm page — verification is consumed by an explicit POST there, never by
// fetching the GET link (mail scanners prefetch links, which must not verify
// anything). Returns whether the mail was accepted for delivery; the caller
// decides how to surface a failure (register ignores it best-effort, the
// profile flow clears the row and reports it).
export async function dispatchEmailVerification(
  env: Env,
  origin: string,
  uid: number,
  email: string
): Promise<boolean> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO email_verifications (user_id, email, token, sent_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE SET
       email = excluded.email, token = excluded.token, sent_at = excluded.sent_at, expires_at = excluded.expires_at`
  )
    .bind(uid, email, await sha256Hex(token), nowIso(), new Date(Date.now() + VERIFY_TTL_MS).toISOString())
    .run();

  const link = `${origin}/verify-email?token=${token}`;
  return sendEmail(
    env,
    email,
    "Verify your email: Show Us TV",
    `Confirm this email address for your Show Us TV account:\n\n${link}\n\nThe link expires in 24 hours. If you didn't request this, ignore it.`,
    brandedEmailHtml({
      preheader: "Confirm this email address for your Show Us TV account.",
      heading: "Verify your email",
      intro: "Confirm this email address for your Show Us TV account.",
      buttonLabel: "Verify email",
      buttonUrl: link,
      footnote: "This link expires in 24 hours. If you didn't request this, you can safely ignore this email.",
    })
  );
}
