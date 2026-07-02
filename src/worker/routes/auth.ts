import { Hono } from "hono";
import type { AppEnv } from "../env";
import { hashPassword, verifyPassword } from "../lib/password";
import { issueSession, clearSession, requireAuth } from "../lib/session";
import { isValidTz } from "../lib/dates";

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
    return c.json({ user: { id: row!.id, username, tz } });
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
    "SELECT id, username, pw_hash, tz FROM users WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<{ id: number; username: string; pw_hash: string; tz: string }>();

  if (!user || !(await verifyPassword(password, user.pw_hash))) {
    return c.json({ error: "Wrong username or password" }, 401);
  }
  await issueSession(c, user.id, user.tz);
  return c.json({ user: { id: user.id, username: user.username, tz: user.tz } });
});

auth.post("/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, async (c) => {
  const user = await c.env.DB.prepare("SELECT id, username, tz FROM users WHERE id = ?1")
    .bind(c.get("uid"))
    .first();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ user });
});

auth.put("/settings", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tz = String(body.tz ?? "");
  if (!isValidTz(tz)) return c.json({ error: "Invalid timezone" }, 400);
  await c.env.DB.prepare("UPDATE users SET tz = ?1 WHERE id = ?2").bind(tz, c.get("uid")).run();
  await issueSession(c, c.get("uid"), tz); // tz rides in the cookie
  return c.json({ ok: true });
});
