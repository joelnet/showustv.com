import { Hono } from "hono";
import type { AppEnv } from "../env";
import { hashPassword, verifyPassword } from "../lib/password";
import { issueSession, clearSession, readSession, requireAuth } from "../lib/session";
import { isValidTz, nowIso } from "../lib/dates";
import { sha256Hex } from "../lib/email";
import { USERNAME_RE, USERNAME_RULES } from "../lib/username";

export const auth = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sign-up asks only for an email (issue #23); the account gets a random,
// human-friendly handle it can rename later on the profile page. Kept short
// enough (<= 20 chars) to satisfy the username rules with room for the number.
const HANDLE_ADJ = ["late","prime","static","neon","velvet","golden","rerun","binge","pixel","analog","noir","retro","turbo","lucid","hazy","cosmic","stellar","primetime"];
const HANDLE_NOUN = ["viewer","binger","pilot","finale","marathon","channel","screen","reel","slate","cameo","encore","sitcom","drama","spoiler","rerun","couch"];

function randomHandle(): string {
  const buf = new Uint32Array(3);
  crypto.getRandomValues(buf);
  const a = HANDLE_ADJ[buf[0] % HANDLE_ADJ.length];
  const n = HANDLE_NOUN[buf[1] % HANDLE_NOUN.length];
  return `${a}${n}${buf[2] % 10000}`.slice(0, 20);
}

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const tz = isValidTz(String(body.tz ?? "")) ? String(body.tz) : "UTC";

  if (!EMAIL_RE.test(email) || email.length > 254)
    return c.json({ error: "That doesn't look like an email address" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first();
  if (taken) return c.json({ error: "That email is already in use" }, 409);

  const pwHash = await hashPassword(password);
  // Sign-up stores the email straight away (unverified) — it's the login. The
  // random handle can collide, so retry a few times before giving up. Sign-in is
  // open to everyone: the account is created and a session issued right away.
  for (let attempt = 0; attempt < 6; attempt++) {
    const username = randomHandle();
    try {
      const row = await c.env.DB.prepare(
        "INSERT INTO users (username, email, pw_hash, tz) VALUES (?1, ?2, ?3, ?4) RETURNING id"
      )
        .bind(username, email, pwHash, tz)
        .first<{ id: number }>();
      c.set("uid", row!.id); // attribute this request in the activity log
      await issueSession(c, row!.id, tz);
      // onboarded: false routes the fresh account to the preferences step
      // (issue #160), where it confirms this handle and timezone.
      return c.json({
        user: { id: row!.id, username, tz, emailVerified: false, isAdmin: false, installed: false, onboarded: false },
      });
    } catch (e: any) {
      const msg = String(e.message);
      if (msg.includes("users.email")) return c.json({ error: "That email is already in use" }, 409);
      if (msg.includes("users.username")) continue; // handle clash — pick another and retry
      throw e;
    }
  }
  return c.json({ error: "Couldn't create your account. Please try again" }, 500);
});

auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // Accept the email (the new login) or the username (existing accounts).
  const login = String(body.login ?? body.email ?? body.username ?? "").trim();
  const password = String(body.password ?? "");

  const user = await c.env.DB.prepare(
    "SELECT id, username, pw_hash, tz, email_verified_at, is_admin, installed_at, onboarded_at FROM users WHERE (email = ?1 OR username = ?1) AND deleted_at IS NULL"
  )
    .bind(login)
    .first<{
      id: number;
      username: string;
      pw_hash: string;
      tz: string;
      email_verified_at: string | null;
      is_admin: number;
      installed_at: string | null;
      onboarded_at: string | null;
    }>();

  if (!user || !(await verifyPassword(password, user.pw_hash))) {
    return c.json({ error: "Wrong email or password" }, 401);
  }

  await issueSession(c, user.id, user.tz);
  c.set("uid", user.id); // attribute this request in the activity log
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      tz: user.tz,
      emailVerified: !!user.email_verified_at,
      isAdmin: !!user.is_admin,
      installed: !!user.installed_at,
      onboarded: !!user.onboarded_at,
    },
  });
});

auth.post("/logout", async (c) => {
  // Best-effort attribution for the activity log; logout must still work
  // with an invalid or expired cookie, so no requireAuth here.
  const session = await readSession(c);
  if (session) c.set("uid", session.u);
  clearSession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, username, tz, (email_verified_at IS NOT NULL) AS verified, is_admin, (installed_at IS NOT NULL) AS installed, (onboarded_at IS NOT NULL) AS onboarded FROM users WHERE id = ?1"
  )
    .bind(c.get("uid"))
    .first<{ id: number; username: string; tz: string; verified: number; is_admin: number; installed: number; onboarded: number }>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      tz: user.tz,
      emailVerified: !!user.verified,
      isAdmin: !!user.is_admin,
      installed: !!user.installed,
      onboarded: !!user.onboarded,
    },
  });
});

// A confirmed PWA install self-reports here (issue #145): Chromium's
// appinstalled event, or the first signed-in standalone boot on iOS (which
// fires no install event at all). The activity_log middleware records the
// POST, so the install lands in the activity logs attributed and timestamped
// like every other user action; installed_at keeps its set-once semantics
// from migration 0015. Idempotent: the conditional UPDATE is atomic, so
// racing pings (several open tabs all receiving appinstalled) yield exactly
// one 201 — the tracked install event — and the client's `installed` flag
// stops re-pings on later standalone launches. A duplicate ping still gets
// an ordinary request-audit row (status 200) like every mutating endpoint
// does; only the 201 row means "install recorded". Unlike the pre-#82 flag,
// nothing gates the Install button on this.
auth.post("/installed", requireAuth, async (c) => {
  const { meta } = await c.env.DB.prepare("UPDATE users SET installed_at = ?2 WHERE id = ?1 AND installed_at IS NULL")
    .bind(c.get("uid"), nowIso())
    .run();
  // 201 = first transition (the tracked install); 200 = already recorded.
  return c.json({ ok: true }, (meta.changes ?? 0) > 0 ? 201 : 200);
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
  c.set("uid", row.user_id); // attribute this request in the activity log
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

// "Finish Signup" on the preferences step (issue #160): one atomic call that
// saves the username + timezone and marks onboarding complete, so a partial
// failure can't strand an account half-onboarded. Validation matches the
// standing rules exactly: PUT /profile/username's shape check and taken
// handling (the register handle can be sniped between register and finish,
// hence the 409), and PUT /auth/settings' timezone check + cookie refresh.
// COALESCE keeps onboarded_at set-once, like installed_at.
auth.post("/onboarding", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const tz = String(body.tz ?? "");
  if (!USERNAME_RE.test(username)) return c.json({ error: USERNAME_RULES }, 400);
  if (!isValidTz(tz)) return c.json({ error: "Invalid timezone" }, 400);
  try {
    await c.env.DB.prepare("UPDATE users SET username = ?2, tz = ?3, onboarded_at = COALESCE(onboarded_at, ?4) WHERE id = ?1")
      .bind(c.get("uid"), username, tz, nowIso())
      .run();
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return c.json({ error: "That username is taken" }, 409);
    throw e;
  }
  await issueSession(c, c.get("uid"), tz); // tz rides in the cookie
  return c.json({ ok: true, username, tz });
});
