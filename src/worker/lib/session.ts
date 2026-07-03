// Stateless sessions: HMAC-SHA256-signed cookie, zero storage ops per request.
// Payload carries uid + tz; changing tz in settings reissues the cookie.

import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";

const COOKIE = "sess";
const TTL_SECONDS = 30 * 24 * 3600;

interface SessionPayload {
  u: number;
  tz: string;
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
  const payload: SessionPayload = { u: uid, tz, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS };
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

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("uid", session.u);
  c.set("tz", session.tz);
  await next();
}
