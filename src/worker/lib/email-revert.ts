// Old-address notification + one-click revert. When a verified
// account's email is swapped to a new address (POST /auth/verify-email), the
// PREVIOUS address is emailed a security notice with a single-use revert link,
// so a silent takeover always leaves a signal the rightful owner can act on.
//
// Mirrors the forgot-password token flow: only the token's
// SHA-256 digest is stored (the raw token lives solely in the email, so a DB
// leak can't revert anyone's email), one pending revert per user (a newer
// change replaces the row), a short TTL, and the worker deletes the row on
// first use (routes/auth.ts POST /auth/revert-email).

import type { Env } from "../env";
import { sendEmail, sha256Hex, brandedEmailHtml } from "./email";
import { nowIso } from "./dates";

// A generous but bounded window: a takeover victim may not read mail for a few
// days, and the token is an unguessable, digest-only, single-use bearer
// credential, so a longer life costs little.
export const REVERT_TTL_MS = 7 * 24 * 3600 * 1000;

// Store (replacing any prior pending row) the revert token for a user and mail
// the security notice to the OLD address. Best-effort and off the response path
// (the caller runs it in waitUntil): a mail hiccup must not fail the email
// verification that triggered it. If the send fails the row is deleted — an
// undeliverable token has no business sitting in the DB, and no one holds the
// link anyway.
export async function notifyEmailChanged(
  env: Env,
  origin: string,
  uid: number,
  prevEmail: string,
  newEmail: string
): Promise<void> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO email_reverts (user_id, prev_email, token, sent_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE SET
       prev_email = excluded.prev_email, token = excluded.token, sent_at = excluded.sent_at, expires_at = excluded.expires_at`
  )
    .bind(uid, prevEmail, await sha256Hex(token), nowIso(), new Date(Date.now() + REVERT_TTL_MS).toISOString())
    .run();

  const link = `${origin}/revert-email?token=${token}`;
  const sent = await sendEmail(
    env,
    prevEmail,
    "Your Show Us TV email address was changed",
    `The email address on your Show Us TV account was just changed to ${newEmail}.\n\nIf you made this change, you can ignore this message. If you did NOT, open this link to restore ${prevEmail} and sign every other session out of your account:\n\n${link}\n\nThe link expires in 7 days and can be used once.`,
    brandedEmailHtml({
      preheader: `Your Show Us TV email was changed to ${newEmail}.`,
      heading: "Your email address was changed",
      intro: `The email address on your Show Us TV account was just changed to ${newEmail}. If that wasn't you, restore your old address below — it also signs every other session out of your account.`,
      buttonLabel: "Restore my email",
      buttonUrl: link,
      footnote: "This link expires in 7 days and can be used once. If you made this change, you can safely ignore this email.",
    })
  );
  if (!sent) await env.DB.prepare("DELETE FROM email_reverts WHERE user_id = ?1").bind(uid).run();
}
