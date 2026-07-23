// Discord webhook integration (issue #8). The admin panel stores a
// webhook URL plus a notify-on-signup flag in app_settings (0013/0036);
// POST /register fires a best-effort message through here. This replaces the
// external notify-new-users.mjs cron, which polled the user count hourly.
import type { Env } from "../env";

export const WEBHOOK_URL_KEY = "discord_webhook_url";
export const NOTIFY_SIGNUPS_KEY = "discord_notify_signups";

// SSRF guard: the server fetches this admin-supplied URL, so only a real
// Discord webhook endpoint is acceptable — https on a known Discord host
// (default port, no embedded credentials) with the /api/webhooks/ path.
// Enforced on save (routes/admin.ts) AND again right before every fire, so a
// bad value that reaches the DB some other way still never gets fetched.
const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

export function isDiscordWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.port === "" && // 443 normalizes to ""; any explicit non-default port fails
    u.username === "" &&
    u.password === "" &&
    DISCORD_WEBHOOK_HOSTS.has(u.hostname.toLowerCase()) &&
    u.pathname.startsWith("/api/webhooks/") // URL parsing already collapsed any ../
  );
}

export async function getDiscordSettings(db: D1Database): Promise<{ webhookUrl: string; notifySignups: boolean }> {
  const { results } = await db
    .prepare("SELECT key, value FROM app_settings WHERE key IN (?1, ?2)")
    .bind(WEBHOOK_URL_KEY, NOTIFY_SIGNUPS_KEY)
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  return {
    webhookUrl: map.get(WEBHOOK_URL_KEY) ?? "",
    notifySignups: map.get(NOTIFY_SIGNUPS_KEY) === "1",
  };
}

// New-signup ping, fired from POST /register via waitUntil. Best-effort by
// contract: every failure lands in the catch below and is only logged —
// nothing here may ever block or fail the signup itself. The message mirrors
// the retired cron script's format, per signup instead of per polling delta.
export async function notifyDiscordSignup(env: Env): Promise<void> {
  try {
    const { webhookUrl, notifySignups } = await getDiscordSettings(env.DB);
    if (!notifySignups || !webhookUrl) return;
    if (!isDiscordWebhookUrl(webhookUrl)) {
      console.error("discord signup notify: stored URL is not a Discord webhook — refusing to fire");
      return;
    }
    // Same count the old cron reported (admin CLI `usercount`): active users.
    const row = await env.DB.prepare("SELECT COUNT(*) AS users FROM users WHERE deleted_at IS NULL").first<{ users: number }>();
    const content =
      `🎉 **New user** signed up on [Show Us TV](https://showustv.com)!` +
      (typeof row?.users === "number" ? `\nTotal users: **${row.users}**.` : "");
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) console.error(`discord signup notify: webhook returned ${res.status}`);
  } catch (e) {
    console.error("discord signup notify failed", e);
  }
}
