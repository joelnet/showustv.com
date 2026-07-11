import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { hashPassword, verifyPassword, DUMMY_PW_HASH } from "../lib/password";
import { issueSession, clearSession, readSession, requireAuth } from "../lib/session";
import { isValidTz, nowIso } from "../lib/dates";
import { sha256Hex } from "../lib/email";
import { USERNAME_RE, USERNAME_RULES } from "../lib/username";
import { isRateLimited, recordAttempt, clearAttempts } from "../lib/rate-limit";
import { readJson } from "../lib/body";

export const auth = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Issue #217: PBKDF2 hashes whatever it's given, so an unbounded password is
// a CPU-DoS amplifier. Both register and login refuse anything longer BEFORE
// any hashing (signInExistingUser is only reachable from register, after this
// check). Generous enough for any passphrase; register enforces it, so no
// legitimate account can hold a longer password that login would then refuse.
const MAX_PASSWORD_CHARS = 256;
const PASSWORD_RULES = { error: "Password must be between 8 and 256 characters" };

// Sliding windows (issues #214/#207). Login counts only FAILED attempts —
// per IP and per normalized identifier — so ordinary sign-ins never brush
// the limit; register counts every attempt, since mass signups are the
// threat there, not guessing. Refused (429) requests are never recorded
// (see lib/rate-limit.ts), which keeps any lockout time-bounded, and one
// generic message covers every trip so a 429 can't confirm an account.
const LOGIN_IP = { limit: 10, windowMs: 10 * 60_000 };
const LOGIN_ID = { limit: 5, windowMs: 15 * 60_000 };
const REGISTER_IP = { limit: 10, windowMs: 60 * 60_000 };
const REGISTER_EMAIL = { limit: 5, windowMs: 60 * 60_000 };
const RATE_LIMITED = { error: "Too many attempts. Please try again later" };

// Cloudflare's view of the client; local dev has no CF header, so everything
// shares one bucket there. slice bounds what an attacker can make us store.
const clientIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? "unknown";
const loginKeys = (c: Context<AppEnv>, identifier: string) => ({
  ipKey: `login:ip:${clientIp(c)}`,
  idKey: `login:id:${identifier.toLowerCase().slice(0, 254)}`,
});

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

// Issue #174: submitting an existing account's email + correct password on
// the create-account form means "sign me in", so /register hands the request
// off here instead of erroring. Same password check (verifyPassword — PBKDF2
// + timingSafeEqual) and same session (issueSession) as /login, and the same
// deleted_at filter, so an account /login would refuse can't sneak in here.
// The lookup is by email only: register's identifier is validated as an
// email, and usernames (USERNAME_RE) can never contain "@", so it can't
// ambiguously match a different user's username. Returns null on a wrong
// password (or deleted account) — the caller keeps today's 409, so this path
// is indistinguishable from the old behavior when the sign-in doesn't happen.
//
// Because this is a login in disguise, it shares /login's brakes (issue
// #214) — same keys, same windows, same dummy verify — or /register would be
// the unthrottled way to guess an existing account's password. When limited
// it returns the generic 429 Response, which the caller passes through.
async function signInExistingUser(c: Context<AppEnv>, email: string, password: string) {
  const { ipKey, idKey } = loginKeys(c, email);
  if (await isRateLimited(c.env.DB, [{ key: ipKey, ...LOGIN_IP }, { key: idKey, ...LOGIN_ID }]))
    return c.json(RATE_LIMITED, 429);
  const user = await c.env.DB.prepare(
    "SELECT id, username, pw_hash, tz, email_verified_at, is_admin, installed_at, onboarded_at FROM users WHERE email = ?1 AND deleted_at IS NULL"
  )
    .bind(email)
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
  // The dummy verify covers the deleted-account case (the caller's `taken`
  // pre-check has no deleted_at filter), keeping timing flat here too.
  const ok = await verifyPassword(password, user?.pw_hash ?? DUMMY_PW_HASH);
  if (!user || !ok) {
    await recordAttempt(c.env.DB, [ipKey, idKey]);
    return null;
  }
  await clearAttempts(c.env.DB, [idKey]); // correct password ends the account's failure window

  await issueSession(c, user.id, user.tz);
  c.set("uid", user.id); // attribute this request in the activity log
  return c.json({
    signedIn: true, // tells the client this was a sign-in, not a new account
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
}

auth.post("/register", async (c) => {
  const rj = await readJson(c); // byte cap before parsing (issue #217)
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const { body } = rj;
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const tz = isValidTz(String(body.tz ?? "")) ? String(body.tz) : "UTC";

  if (!EMAIL_RE.test(email) || email.length > 254)
    return c.json({ error: "That doesn't look like an email address" }, 400);
  if (password.length < 8 || password.length > MAX_PASSWORD_CHARS) return c.json(PASSWORD_RULES, 400);

  // Mass-signup brake (issues #214/#207): a well-formed attempt counts when
  // it lands as a create or a 409 — a bot probing emails burns its budget
  // either way. Recording waits until the outcome is known so that neither a
  // 429 (from here or the sign-in handoff below) nor a successful sign-in
  // spends register quota — the same failures-only spirit as /login.
  const regIpKey = `register:ip:${clientIp(c)}`;
  const regEmailKey = `register:email:${email}`;
  if (await isRateLimited(c.env.DB, [{ key: regIpKey, ...REGISTER_IP }, { key: regEmailKey, ...REGISTER_EMAIL }]))
    return c.json(RATE_LIMITED, 429);

  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first();
  if (taken) {
    const signedIn = await signInExistingUser(c, email, password); // a 200 or its own 429
    if (signedIn) return signedIn;
    await recordAttempt(c.env.DB, [regIpKey, regEmailKey]); // wrong password: count the probe
    return c.json({ error: "That email is already in use" }, 409);
  }
  await recordAttempt(c.env.DB, [regIpKey, regEmailKey]);

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
      // Email landed between the pre-check and the insert (e.g. a double
      // submit): same rule as above — right password signs in, else 409.
      if (msg.includes("users.email"))
        return (await signInExistingUser(c, email, password)) ?? c.json({ error: "That email is already in use" }, 409);
      if (msg.includes("users.username")) continue; // handle clash — pick another and retry
      throw e;
    }
  }
  return c.json({ error: "Couldn't create your account. Please try again" }, 500);
});

auth.post("/login", async (c) => {
  const rj = await readJson(c); // byte cap before parsing (issue #217)
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const { body } = rj;
  // Accept the email (the new login) or the username (existing accounts).
  const login = String(body.login ?? body.email ?? body.username ?? "").trim();
  const password = String(body.password ?? "");
  // No account can hold a password this long (register refuses them), so
  // reject before the rate-limit reads and the PBKDF2 verify (issue #217).
  if (password.length > MAX_PASSWORD_CHARS) return c.json(PASSWORD_RULES, 400);

  // Brute-force brake (issues #214/#207): only failures are recorded (below),
  // so this trips on guessing, never on routine sign-ins.
  const { ipKey, idKey } = loginKeys(c, login);
  if (await isRateLimited(c.env.DB, [{ key: ipKey, ...LOGIN_IP }, { key: idKey, ...LOGIN_ID }]))
    return c.json(RATE_LIMITED, 429);

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

  // Always run the full PBKDF2 — against a dummy record when the account
  // doesn't exist — so the not-found branch is no longer measurably faster
  // than a wrong password (the timing oracle in issue #214).
  const ok = await verifyPassword(password, user?.pw_hash ?? DUMMY_PW_HASH);
  if (!user || !ok) {
    await recordAttempt(c.env.DB, [ipKey, idKey]);
    return c.json({ error: "Wrong email or password" }, 401);
  }
  await clearAttempts(c.env.DB, [idKey]); // correct password ends the account's failure window

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
