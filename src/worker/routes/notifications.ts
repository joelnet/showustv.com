// Notifications (issue #129): the list behind the header bell, the unread
// count the bell badge polls, per-user type preferences, and Web Push
// subscription registration. Mounted behind requireAuth — every query is
// scoped to the signed-in user.
//
// Read model: rows store ids only (type, actor, target); usernames, titles
// and posters join in at read time, so renames and catalog refreshes are
// always current — same philosophy as the activity feed.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { nowIso } from "../lib/dates";
import { vapidConfigured } from "../lib/push";

export const notifications = new Hono<AppEnv>();

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 50;

// Newest first, keyset-paginated on id (monotonic enough for a per-user
// notification stream; ties are impossible). `before` is the last id of the
// previous page.
notifications.get("/", async (c) => {
  const uid = c.get("uid");
  const beforeRaw = Number(c.req.query("before"));
  const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;

  // Episode details (season/number/title) join in live off n.episode_id — the
  // read model stores ids and resolves display text at read time, so a later
  // episode-title fix shows through and a since-deleted episode degrades to the
  // show-only text (issue #129 follow-up).
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.target_type, n.target_id, n.episode_id, n.read_at, n.created_at,
            u.username AS actor,
            COALESCE(s.title, m.title) AS title,
            COALESCE(s.poster_url, m.poster_url) AS poster,
            e.season_number AS ep_season, e.number AS ep_number, e.title AS ep_title
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id AND u.deleted_at IS NULL
     LEFT JOIN shows s ON n.target_type = 'show' AND s.tmdb_id = n.target_id
     LEFT JOIN movies m ON n.target_type = 'movie' AND m.tmdb_id = n.target_id
     LEFT JOIN episodes e ON e.id = n.episode_id
     WHERE n.user_id = ?1 AND (?2 IS NULL OR n.id < ?2)
     ORDER BY n.id DESC
     LIMIT ?3`
  )
    .bind(uid, before, limit)
    .all<{
      id: number;
      type: string;
      target_type: "show" | "movie" | null;
      target_id: number | null;
      episode_id: number | null;
      read_at: string | null;
      created_at: string;
      actor: string | null;
      title: string | null;
      poster: string | null;
      ep_season: number | null;
      ep_number: number | null;
      ep_title: string | null;
    }>();

  const items = results.map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor,
    targetType: r.target_type,
    targetId: r.target_id,
    title: r.title,
    poster: r.poster,
    // The raw episode id lets an episode-comment notification deep-link the
    // episode page (where the thread lives); season/number/title below are
    // the display fields and go null when the episode left the catalog.
    episodeId: r.episode_id,
    // Present only for episode rows whose episode is still in the catalog.
    season: r.ep_season,
    number: r.ep_number,
    episodeTitle: r.ep_title,
    read: !!r.read_at,
    createdAt: r.created_at,
  }));
  return c.json({
    items,
    // More MIGHT exist when the page came back full; the client stops when a
    // follow-up page is empty (activity-feed convention).
    nextCursor: items.length === limit ? items[items.length - 1].id : null,
  });
});

// The bell badge. The partial index (0020) keeps this O(unread).
notifications.get("/unread-count", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL")
    .bind(c.get("uid"))
    .first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

// Opening the notifications page clears the badge: everything unread up to
// and including `throughId` (the newest id the page actually displayed) is
// marked read in one sweep. The bound matters — an unconditional sweep would
// race with fan-out and mark a notification read that arrived after the page
// fetched but before this call. Idempotent.
notifications.post("/read-all", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const throughId = Number(body.throughId);
  if (!Number.isInteger(throughId) || throughId <= 0) return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare("UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL AND id <= ?3")
    .bind(c.get("uid"), nowIso(), throughId)
    .run();
  return c.json({ ok: true });
});

// ---------- Preferences ----------

// The settings page reads everything in one call. pushPublicKey doubles as
// the push feature flag: null until a human configures BOTH VAPID keys
// (vapidConfigured — a half-configured deployment must not invite
// subscriptions it can never send to), and the client hides the push toggle
// accordingly.
notifications.get("/prefs", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT follow_watch, follow_comment FROM notification_prefs WHERE user_id = ?1 AND show_id = 0"
  )
    .bind(c.get("uid"))
    .first<{ follow_watch: number; follow_comment: number }>();
  return c.json({
    // Defaults on when no row, matching the fan-outs' COALESCE.
    followWatch: row ? !!row.follow_watch : true,
    followComment: row ? !!row.follow_comment : true,
    pushPublicKey: vapidConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY! : null,
  });
});

// Partial update: the settings page flips one toggle at a time, so each key
// is optional — but at least one must be present. An omitted key keeps its
// stored value (or its default, on the INSERT arm).
notifications.put("/prefs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const followWatch = typeof body.followWatch === "boolean" ? (body.followWatch ? 1 : 0) : null;
  const followComment = typeof body.followComment === "boolean" ? (body.followComment ? 1 : 0) : null;
  if (followWatch == null && followComment == null) return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO notification_prefs (user_id, show_id, follow_watch, follow_comment)
     VALUES (?1, 0, COALESCE(?2, 1), COALESCE(?3, 1))
     ON CONFLICT (user_id, show_id) DO UPDATE SET
       follow_watch = COALESCE(?2, follow_watch),
       follow_comment = COALESCE(?3, follow_comment)`
  )
    .bind(c.get("uid"), followWatch, followComment)
    .run();
  return c.json({ ok: true });
});

// ---------- Web Push subscriptions ----------

// Decoded byte length of a base64url string; -1 when it isn't base64url.
function b64urlByteLen(s: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return -1;
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/")).length;
  } catch {
    return -1;
  }
}

// The browser's PushSubscription.toJSON() shape: { endpoint, keys: { p256dh, auth } }.
// The worker later POSTs to this endpoint from lib/notifications.ts, so it's
// validated as a real push subscription, not just "some URL": p256dh must be
// an uncompressed P-256 point (65 bytes) and auth a 16-byte secret — junk
// keys would only die inside buildPushPayload at send time — and the
// endpoint must be a clean https URL (no credentials, no IP-literal or
// localhost host). Push services come and go and browsers ship new ones, so
// there's deliberately no hostname allowlist; the payload we'd POST is the
// recipient's own encrypted notification, so a hostile endpoint learns
// nothing it doesn't already know.
function parseSubscription(body: any): { endpoint: string; p256dh: string; auth: string } | null {
  const endpoint = String(body?.endpoint ?? "");
  const p256dh = String(body?.keys?.p256dh ?? "");
  const auth = String(body?.keys?.auth ?? "");
  if (!endpoint || endpoint.length > 2048) return null;
  if (b64urlByteLen(p256dh) !== 65 || b64urlByteLen(auth) !== 16) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null; // IP literals
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

// Register (or re-register) this device. The endpoint is globally unique per
// subscription; on conflict the row moves to the signed-in user — a shared
// browser must push to whoever is signed in now, not a previous account.
notifications.post("/push/subscribe", async (c) => {
  const sub = parseSubscription(await c.req.json().catch(() => ({})));
  if (!sub) return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`
  )
    .bind(c.get("uid"), sub.endpoint, sub.p256dh, sub.auth, c.req.header("user-agent") ?? null)
    .run();
  return c.json({ ok: true });
});

// Turning push off in settings. Scoped to the signed-in user so nobody can
// delete someone else's subscription by guessing an endpoint. Idempotent.
notifications.post("/push/unsubscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const endpoint = String(body?.endpoint ?? "");
  if (endpoint) {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2")
      .bind(c.get("uid"), endpoint)
      .run();
  }
  return c.json({ ok: true });
});
