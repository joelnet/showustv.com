// Admin-only endpoints (issue #17). Mounted behind requireAuth; the
// middleware below additionally requires users.is_admin. Non-admins get an
// indistinguishable 404 — the admin surface shouldn't be enumerable.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AppEnv } from "../env";
import { isSiteOpen, setSiteOpen } from "../lib/settings";
import { sendEmail } from "../lib/email";

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

// Open or close the site (issue #26). Opening admits everyone — including the
// wait list — so it clears the waitlisted flag (retiring the concept, so no
// waitlisted session can linger if the site is later closed again) and emails
// everyone who was waiting. The mutation is audited by the global middleware.
admin.get("/site-open", async (c) => c.json({ siteOpen: await isSiteOpen(c.env) }));

admin.put("/site-open", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.open !== "boolean") return c.json({ error: "open must be true or false" }, 400);
  await setSiteOpen(c.env, b.open);

  let notified = 0;
  if (b.open) {
    const { results } = await c.env.DB.prepare(
      "SELECT email FROM users WHERE waitlisted = 1 AND email IS NOT NULL AND deleted_at IS NULL"
    ).all<{ email: string }>();
    // Admit them first; the emails are a best-effort courtesy sent after we
    // respond (a slow provider must not stall the toggle).
    await c.env.DB.prepare("UPDATE users SET waitlisted = 0 WHERE waitlisted = 1").run();
    notified = results.length;
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      (async () => {
        for (const u of results) {
          await sendEmail(
            c.env,
            u.email,
            "Show Us TV is open — you're in",
            `Good news — Show Us TV is now open. You can sign in and start tracking what you watch:\n\n${origin}/login\n`
          ).catch(() => {});
        }
      })()
    );
  }
  return c.json({ ok: true, siteOpen: b.open, notified });
});

// Account flags for the admin panel on profiles.
admin.get("/users/:username", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT username, is_admin, shadow_banned, email_verified_at, created_at FROM users WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(c.req.param("username"))
    .first<{ username: string; is_admin: number; shadow_banned: number; email_verified_at: string | null; created_at: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    user: {
      username: row.username,
      isAdmin: !!row.is_admin,
      shadowBanned: !!row.shadow_banned,
      emailVerified: !!row.email_verified_at,
      createdAt: row.created_at,
    },
  });
});

// Toggle shadow ban (issue #18). The mutation lands in activity_log via the
// global middleware, so the ban/unban itself is audited.
admin.put("/users/:username/shadow-ban", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.banned !== "boolean") return c.json({ error: "banned must be true or false" }, 400);
  const { meta } = await c.env.DB.prepare(
    "UPDATE users SET shadow_banned = ?2 WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(c.req.param("username"), b.banned ? 1 : 0)
    .run();
  if (!meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, shadowBanned: b.banned });
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
