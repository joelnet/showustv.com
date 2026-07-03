// Admin-only endpoints (issue #17). Mounted behind requireAuth; the
// middleware below additionally requires users.is_admin. Non-admins get an
// indistinguishable 404 — the admin surface shouldn't be enumerable.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AppEnv } from "../env";

export const admin = new Hono<AppEnv>();

admin.use("*", async (c: Context<AppEnv>, next: Next) => {
  const row = await c.env.DB.prepare("SELECT is_admin FROM users WHERE id = ?1")
    .bind(c.get("uid"))
    .first<{ is_admin: number }>();
  if (!row?.is_admin) return c.json({ error: "not found" }, 404);
  await next();
  // Other users' audit trails must not linger in any cache (the service
  // worker also skips /api/admin/ — this covers everything else).
  c.res.headers.set("cache-control", "no-store");
});

// A user's recent audit trail (activity_log, issue #15) for troubleshooting.
// Works for any account, public profile or not. Reading it is itself
// recorded: the global middleware only logs mutations, so this GET inserts
// its own row — admin oversight must be auditable too.
admin.get("/users/:username/activity", async (c) => {
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?1")
    .bind(c.req.param("username"))
    .first<{ id: number }>();
  if (!target) return c.json({ error: "not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT ts, method, route, path, status FROM activity_log WHERE user_id = ?1 ORDER BY id DESC LIMIT 100"
  )
    .bind(target.id)
    .all();

  c.executionCtx.waitUntil(
    c.env.DB.prepare("INSERT INTO activity_log (user_id, method, route, path, status) VALUES (?1, 'GET', ?2, ?3, 200)")
      .bind(c.get("uid"), "/api/admin/users/:username/activity", new URL(c.req.url).pathname)
      .run()
      .catch((e) => console.error("admin activity-view log failed", e))
  );
  return c.json({ activity: results });
});
