// Admin-only endpoints. Mounted behind requireAuth; the
// middleware below additionally requires users.is_admin. Non-admins get an
// indistinguishable 404 — the admin surface shouldn't be enumerable.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AppEnv } from "../env";
import { getDiscordSettings, isDiscordWebhookUrl, NOTIFY_SIGNUPS_KEY, WEBHOOK_URL_KEY } from "../lib/discord";
import { AUTO_FOLLOW_USERNAME_KEY, getAutoFollowUsername, normalizeAutoFollowUsername } from "../lib/auto-follow";
import { USERNAME_RE, USERNAME_RULES } from "../lib/username";
import { notifyTestNotification } from "../lib/notifications";

export const admin = new Hono<AppEnv>();

// Shared upsert into the app_settings key/value store (0013).
const UPSERT_SETTING =
  "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

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

// Toggle shadow ban. The mutation lands in activity_log via the
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

// Test notification: the admin page's button. Sends the caller
// themselves an in-app notification (and Web Push to their subscribed
// devices) so an admin can verify the pipeline end to end. Awaited — the
// button's toast should mean the row really exists — and safe to await:
// push failures are swallowed inside sendPush, never thrown. The admin gate
// is the sub-app middleware above; the mutation lands in activity_log via
// the global middleware like every other admin action.
admin.post("/test-notification", async (c) => {
  await notifyTestNotification(c.env, c.get("uid"));
  return c.json({ ok: true });
});

// Discord webhook config (issue #8): the admin page's integrations
// section. Stored in app_settings (0013/0036); POST /register reads it to
// fire the new-signup ping (lib/discord.ts). Admin-gated like everything
// here, and the PUT lands in activity_log via the global middleware.
admin.get("/discord", async (c) => c.json(await getDiscordSettings(c.env.DB)));

admin.put("/discord", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.webhookUrl !== "string" || typeof b.notifySignups !== "boolean")
    return c.json({ error: "webhookUrl (string) and notifySignups (boolean) are required" }, 400);
  const webhookUrl = b.webhookUrl.trim();
  if (webhookUrl.length > 400) return c.json({ error: "That URL is too long" }, 400);
  // SSRF gate: the server will fetch this URL on signups, so only a real
  // Discord webhook may be stored (empty clears it). lib/discord.ts checks
  // again before every fire.
  if (webhookUrl !== "" && !isDiscordWebhookUrl(webhookUrl))
    return c.json({ error: "That isn't a Discord webhook URL (expected https://discord.com/api/webhooks/…)" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare(UPSERT_SETTING).bind(WEBHOOK_URL_KEY, webhookUrl),
    c.env.DB.prepare(UPSERT_SETTING).bind(NOTIFY_SIGNUPS_KEY, b.notifySignups ? "1" : "0"),
  ]);
  return c.json({ ok: true });
});

// Signup auto-follow config (issues #11/#14): the account every new
// signup starts out silently following. Issue #11 hard-coded "joelnet"; the
// username now lives in app_settings (0037) and this pair backs the admin
// page's textbox. Empty = feature off. POST /register resolves the name live
// at signup (routes/auth.ts autoFollowOnSignup), so the save only soft-warns
// (exists: false in the response) when no such account is live right now —
// it never rejects for that, and an unmatched name simply means no follow.
// Admin-gated by the sub-app middleware above; the PUT lands in activity_log
// via the global middleware like every other admin mutation.
admin.get("/auto-follow", async (c) => c.json({ username: await getAutoFollowUsername(c.env.DB) }));

admin.put("/auto-follow", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.username !== "string") return c.json({ error: "username (string) is required" }, 400);
  const username = normalizeAutoFollowUsername(b.username);
  // Empty clears the setting (feature off); anything else must at least be
  // shaped like a username so junk never lands in app_settings.
  if (username !== "" && !USERNAME_RE.test(username)) return c.json({ error: USERNAME_RULES }, 400);
  await c.env.DB.prepare(UPSERT_SETTING).bind(AUTO_FOLLOW_USERNAME_KEY, username).run();
  const exists =
    username === "" ||
    !!(await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?1 AND deleted_at IS NULL").bind(username).first());
  return c.json({ ok: true, username, exists });
});

// A user's recent audit trail (activity_log) for troubleshooting.
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
