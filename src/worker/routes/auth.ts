import { Hono } from "hono";
import type { AppEnv } from "../env";
import { hashPassword, verifyPassword } from "../lib/password";
import { issueSession, clearSession, requireAuth } from "../lib/session";
import { isValidTz, nowIso } from "../lib/dates";
import { sha256Hex } from "../lib/email";

export const auth = new Hono<AppEnv>();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const tz = isValidTz(String(body.tz ?? "")) ? String(body.tz) : "UTC";

  if (!USERNAME_RE.test(username)) return c.json({ error: "Username must be 3–20 letters, digits, or _" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const pwHash = await hashPassword(password);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO users (username, pw_hash, tz) VALUES (?1, ?2, ?3) RETURNING id"
    )
      .bind(username, pwHash, tz)
      .first<{ id: number }>();
    await issueSession(c, row!.id, tz);
    return c.json({ user: { id: row!.id, username, tz, emailVerified: false } });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return c.json({ error: "Username is taken" }, 409);
    throw e;
  }
});

auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");

  const user = await c.env.DB.prepare(
    "SELECT id, username, pw_hash, tz, email_verified_at FROM users WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<{ id: number; username: string; pw_hash: string; tz: string; email_verified_at: string | null }>();

  if (!user || !(await verifyPassword(password, user.pw_hash))) {
    return c.json({ error: "Wrong username or password" }, 401);
  }
  await issueSession(c, user.id, user.tz);
  return c.json({ user: { id: user.id, username: user.username, tz: user.tz, emailVerified: !!user.email_verified_at } });
});

auth.post("/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, username, tz, (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = ?1"
  )
    .bind(c.get("uid"))
    .first<{ id: number; username: string; tz: string; verified: number }>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ user: { id: user.id, username: user.username, tz: user.tz, emailVerified: !!user.verified } });
});

// Consume a verification token. POST only: the emailed link lands on the
// SPA page /verify-email, and verification happens when the user presses
// the confirm button there — a mail scanner prefetching the GET link can't
// verify anything. Token alone is the proof (the clicker may be logged out
// or on another device), so this stays outside requireAuth. Single-use:
// the row is deleted on first presentation, valid or expired. Only the
// token's SHA-256 digest is stored, so a DB leak can't mint verifications.
auth.post("/verify-email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token ?? "");
  const status = (s: string) => c.json({ status: s });
  if (!/^[a-f0-9]{32}$/.test(token)) return status("invalid");

  const row = await c.env.DB.prepare("SELECT user_id, email, expires_at FROM email_verifications WHERE token = ?1")
    .bind(await sha256Hex(token))
    .first<{ user_id: number; email: string; expires_at: string }>();
  if (!row) return status("invalid");
  await c.env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?1").bind(row.user_id).run();
  if (row.expires_at < nowIso()) return status("expired");

  try {
    await c.env.DB.prepare("UPDATE users SET email = ?2, email_verified_at = ?3 WHERE id = ?1")
      .bind(row.user_id, row.email, nowIso())
      .run();
  } catch (e: any) {
    // Someone verified this address in the window since the pre-check.
    if (String(e.message).includes("UNIQUE")) return status("taken");
    throw e;
  }
  return status("verified");
});

auth.put("/settings", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tz = String(body.tz ?? "");
  if (!isValidTz(tz)) return c.json({ error: "Invalid timezone" }, 400);
  await c.env.DB.prepare("UPDATE users SET tz = ?1 WHERE id = ?2").bind(tz, c.get("uid")).run();
  await issueSession(c, c.get("uid"), tz); // tz rides in the cookie
  return c.json({ ok: true });
});
