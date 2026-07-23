// HMAC-SHA256-signed session cookie. The signature is verified with zero
// storage ops, but the cookie is no longer blindly trusted: it carries a
// per-user session_epoch that requireAuth checks against the DB so a session
// can be revoked server-side before its 30-day expiry. Payload
// carries uid + tz + epoch; changing tz in settings reissues the cookie.

import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";

const COOKIE = "sess";
const TTL_SECONDS = 30 * 24 * 3600;

interface SessionPayload {
  u: number;
  tz: string;
  // Per-user revocation counter. Absent on cookies minted before
  // session epochs existed — readSession leaves it undefined and the DB check treats that as 0,
  // matching the users.session_epoch column default, so no mass logout on
  // deploy. Present (as `e`) on every cookie minted since.
  e?: number;
  exp: number; // unix seconds
}

const enc = new TextEncoder();

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return new Uint8Array(sig);
}

export async function issueSession(c: Context<AppEnv>, uid: number, tz: string): Promise<void> {
  // Embed the user's CURRENT session_epoch so the cookie is
  // revocable: bumping users.session_epoch invalidates every cookie minted
  // before the bump. The authoritative value is read here rather than trusted
  // from the caller, so a freshly minted cookie always carries the live epoch —
  // in particular, when the acting user changes their own password/email we
  // bump the epoch FIRST and then re-issue here, so their current device stays
  // signed in while every other session dies.
  const row = await c.env.DB.prepare("SELECT session_epoch FROM users WHERE id = ?1")
    .bind(uid)
    .first<{ session_epoch: number }>();
  const payload: SessionPayload = {
    u: uid,
    tz,
    e: row?.session_epoch ?? 0,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const token = `${body}.${b64url(await sign(c.env.SESSION_SECRET, body))}`;
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_SECONDS,
    secure: new URL(c.req.url).protocol === "https:",
  });
}

export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

// Exported for best-effort attribution on public routes (e.g. logout's
// activity-log row) — routes needing enforcement use requireAuth.
export async function readSession(c: Context<AppEnv>): Promise<SessionPayload | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await sign(c.env.SESSION_SECRET, body);
  let given: Uint8Array;
  try {
    given = unb64url(sig);
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.subtle.timingSafeEqual(given as BufferSource, expected as BufferSource)) return null;
  const payload = JSON.parse(new TextDecoder().decode(unb64url(body))) as SessionPayload;
  if (payload.exp < Date.now() / 1000) return null;
  return payload;
}

// Server-side session authority. A cryptographically valid cookie
// is honored only while BOTH hold:
//   (a) the account still exists and is not soft-deleted/disabled
//       (deleted_at IS NULL) — so a banned/deleted account's cookie stops
//       working immediately, with no epoch bump needed; and
//   (b) the cookie's epoch matches the user's current session_epoch — so a
//       password reset or email change (which increment session_epoch) revokes
//       every session minted before it.
// One indexed primary-key read. Backward-compatible: a legacy cookie with no
// `e` field is read as epoch 0, which equals the column default, so existing
// sessions survive deploy unless their epoch has actually been bumped.
export async function sessionAccountValid(
  db: D1Database,
  payload: SessionPayload
): Promise<boolean> {
  const row = await db
    .prepare("SELECT session_epoch FROM users WHERE id = ?1 AND deleted_at IS NULL")
    .bind(payload.u)
    .first<{ session_epoch: number }>();
  if (!row) return false; // unknown or soft-deleted/disabled account
  return (payload.e ?? 0) === row.session_epoch;
}

// readSession + server-side authority in one call, for public
// routes that compute "viewer" state directly (routes/public.ts) rather than
// through requireAuth/optionalAuth. Returns the payload only when the account
// is live and the cookie's epoch is current, so a revoked or soft-deleted
// session is treated as anonymous — the revocation guarantee holds on public
// authorization decisions (e.g. private-profile visibility) too, not just on
// the authenticated API.
export async function readValidSession(c: Context<AppEnv>): Promise<SessionPayload | null> {
  const session = await readSession(c);
  return session && (await sessionAccountValid(c.env.DB, session)) ? session : null;
}

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  // Enforce server-side revocation + account state. A revoked or
  // deleted account's cookie is cleared so the browser stops resending a dead
  // credential, then rejected.
  if (!(await sessionAccountValid(c.env.DB, session))) {
    clearSession(c);
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("uid", session.u);
  c.set("tz", session.tz);
  await next();
}

// Optional authentication for explicitly public reads: attaches
// uid/tz when a valid session cookie is present so the handler can include
// the viewer's own state, and lets anonymous requests through with neither
// set (handlers branch on `c.get("uid") ?? null`). Never use this on a
// mutation or a user-scoped read — those stay behind requireAuth.
export async function optionalAuth(c: Context<AppEnv>, next: Next) {
  const session = await readSession(c);
  // Same server-side authority as requireAuth: a revoked or
  // deleted session must not be treated as "the viewer" even on a public read.
  // Never 401s — a stale cookie just falls through as anonymous.
  if (session && (await sessionAccountValid(c.env.DB, session))) {
    c.set("uid", session.u);
    c.set("tz", session.tz);
  }
  await next();
}
