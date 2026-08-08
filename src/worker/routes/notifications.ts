// Notifications: the list behind the header bell, the unread
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
  // show-only text.
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.target_type, n.target_id, n.episode_id, n.read_at, n.created_at,
            u.username AS actor,
            -- List rows resolve their name the same way — live at
            -- read time, so a renamed list shows through and a since-deleted one
            -- degrades to "a list". The URL uses the actor (the list owner).
            COALESCE(s.title, m.title, cl.name) AS title,
            COALESCE(s.poster_url, m.poster_url) AS poster,
            e.season_number AS ep_season, e.number AS ep_number, e.title AS ep_title,
            -- Follow rows carry whether the recipient follows the
            -- actor NOW, computed live at read time — so the Follow back button
            -- disappears the moment it's true, however the follow happened
            -- (this button, their profile, the following page). NULL for every
            -- other type (CASE without ELSE).
            CASE WHEN n.type IN ('follow', 'follow_back') THEN
              EXISTS (SELECT 1 FROM follows fb
                      WHERE fb.follower_id = n.user_id AND fb.followee_id = n.actor_id AND fb.state = 'active')
            END AS you_follow_actor,
            ar.reaction,
            rt.score AS rating_score,
            -- Air-date alert rows live-count that day's episodes (same
            -- read-time philosophy): a late-added episode shows through, and
            -- a since-deleted representative episode nulls e.air_date so the
            -- count degrades and the UI falls back to generic copy.
            CASE WHEN n.type = 'new_episode' THEN
              (SELECT COUNT(*) FROM episodes e2
               WHERE e2.show_id = n.target_id AND e2.air_date = e.air_date AND e2.season_number > 0)
            END AS ep_count
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id AND u.deleted_at IS NULL
     LEFT JOIN shows s ON n.target_type = 'show' AND s.tmdb_id = n.target_id
     LEFT JOIN movies m ON n.target_type = 'movie' AND m.tmdb_id = n.target_id
     LEFT JOIN custom_lists cl ON n.target_type = 'list' AND cl.id = n.target_id
     LEFT JOIN episodes e ON e.id = n.episode_id
     -- Reaction rows resolve the reactor's CURRENT reaction live at read
     -- time, like everything else here — change it and old rows follow;
     -- clear it and they degrade to plain "reacted" (#20). Full-PK probe.
     LEFT JOIN activity_reactions ar ON n.type = 'reaction' AND ar.owner_id = n.user_id
       AND ar.target_type = n.target_type AND ar.target_id = n.target_id AND ar.reactor_id = n.actor_id
     -- High-rating rows resolve the actor's CURRENT score the same way —
     -- re-rate and old rows follow; clear it and they degrade to plain
     -- "rated". Full-PK probe on ratings.
     LEFT JOIN ratings rt ON n.type = 'follow_rating' AND rt.user_id = n.actor_id
       AND rt.target_type = n.target_type AND rt.target_id = n.target_id
     WHERE n.user_id = ?1 AND (?2 IS NULL OR n.id < ?2)
     ORDER BY n.id DESC
     LIMIT ?3`
  )
    .bind(uid, before, limit)
    .all<{
      id: number;
      type: string;
      target_type: "show" | "movie" | "list" | null;
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
      you_follow_actor: number | null;
      reaction: string | null;
      rating_score: number | null;
      ep_count: number | null;
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
    // Follow rows only: does the recipient follow the actor right now? Null
    // for other types (and moot when the actor's account is gone).
    youFollowActor: r.you_follow_actor == null ? null : !!r.you_follow_actor,
    // Reaction rows only: the reactor's current reaction, null once cleared
    // (and for every other type).
    reaction: r.reaction,
    // High-rating rows only: the actor's current score, null once cleared
    // (and for every other type).
    ratingScore: r.rating_score,
    // Air-date alert rows only: how many episodes aired that day, counted
    // live; null for other types and when the episode left the catalog.
    epCount: r.ep_count,
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
  const [prefsRes, userRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT follow_watch, follow_comment, tracked_comment, follow_favorite, follow_rating, new_follower, list_created, reaction, push_new_episode FROM notification_prefs WHERE user_id = ?1 AND show_id = 0"
    ).bind(c.get("uid")),
    // notify_min lives on users (global per user, like tz — not a per-type
    // toggle), but the settings page reads everything in this one call.
    c.env.DB.prepare("SELECT notify_min FROM users WHERE id = ?1").bind(c.get("uid")),
  ]);
  const row = (prefsRes.results as {
    follow_watch: number;
    follow_comment: number;
    tracked_comment: number;
    follow_favorite: number;
    follow_rating: number;
    new_follower: number;
    list_created: number;
    reaction: number;
    push_new_episode: number;
  }[])[0];
  const notifyMin = (userRes.results as { notify_min: number }[])[0]?.notify_min ?? 480;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return c.json({
    // Defaults on when no row, matching the fan-outs' COALESCE.
    followWatch: row ? !!row.follow_watch : true,
    followComment: row ? !!row.follow_comment : true,
    trackedComment: row ? !!row.tracked_comment : true,
    followFavorite: row ? !!row.follow_favorite : true,
    followRating: row ? !!row.follow_rating : true,
    newFollower: row ? !!row.new_follower : true,
    listCreated: row ? !!row.list_created : true,
    reaction: row ? !!row.reaction : true,
    pushNewEpisode: row ? !!row.push_new_episode : true,
    // Wall-clock "HH:MM" in the user's own tz — the client's time input
    // renders it in the device's clock format (12-hour with AM/PM for US
    // locales).
    notifyTime: `${pad2(Math.floor(notifyMin / 60))}:${pad2(notifyMin % 60)}`,
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
  const trackedComment = typeof body.trackedComment === "boolean" ? (body.trackedComment ? 1 : 0) : null;
  const followFavorite = typeof body.followFavorite === "boolean" ? (body.followFavorite ? 1 : 0) : null;
  const followRating = typeof body.followRating === "boolean" ? (body.followRating ? 1 : 0) : null;
  const newFollower = typeof body.newFollower === "boolean" ? (body.newFollower ? 1 : 0) : null;
  const listCreated = typeof body.listCreated === "boolean" ? (body.listCreated ? 1 : 0) : null;
  const reaction = typeof body.reaction === "boolean" ? (body.reaction ? 1 : 0) : null;
  const pushNewEpisode = typeof body.pushNewEpisode === "boolean" ? (body.pushNewEpisode ? 1 : 0) : null;
  // Air-date alert delivery time, wall-clock "HH:MM" (stored as minutes past
  // local midnight on users, like tz — global per user, not a per-type
  // toggle). Present-but-malformed is a client bug: reject rather than
  // silently keep the old time.
  let notifyMin: number | null = null;
  if (body.notifyTime !== undefined) {
    if (typeof body.notifyTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.notifyTime))
      return c.json({ error: "bad request" }, 400);
    notifyMin = Number(body.notifyTime.slice(0, 2)) * 60 + Number(body.notifyTime.slice(3));
  }
  if (
    followWatch == null &&
    followComment == null &&
    trackedComment == null &&
    followFavorite == null &&
    followRating == null &&
    newFollower == null &&
    listCreated == null &&
    reaction == null &&
    pushNewEpisode == null &&
    notifyMin == null
  )
    return c.json({ error: "bad request" }, 400);
  const stmts = [];
  if (notifyMin != null) {
    // No session-cookie reissue: unlike tz, notify_min doesn't ride the
    // session — the cron reads it fresh from the DB.
    stmts.push(c.env.DB.prepare("UPDATE users SET notify_min = ?2 WHERE id = ?1").bind(c.get("uid"), notifyMin));
  }
  const anyPref =
    followWatch != null ||
    followComment != null ||
    trackedComment != null ||
    followFavorite != null ||
    followRating != null ||
    newFollower != null ||
    listCreated != null ||
    reaction != null ||
    pushNewEpisode != null;
  if (anyPref) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO notification_prefs (user_id, show_id, follow_watch, follow_comment, tracked_comment, follow_favorite, follow_rating, new_follower, list_created, reaction, push_new_episode)
         VALUES (?1, 0, COALESCE(?2, 1), COALESCE(?3, 1), COALESCE(?4, 1), COALESCE(?5, 1), COALESCE(?6, 1), COALESCE(?7, 1), COALESCE(?8, 1), COALESCE(?9, 1), COALESCE(?10, 1))
         ON CONFLICT (user_id, show_id) DO UPDATE SET
           follow_watch = COALESCE(?2, follow_watch),
           follow_comment = COALESCE(?3, follow_comment),
           tracked_comment = COALESCE(?4, tracked_comment),
           follow_favorite = COALESCE(?5, follow_favorite),
           follow_rating = COALESCE(?6, follow_rating),
           new_follower = COALESCE(?7, new_follower),
           list_created = COALESCE(?8, list_created),
           reaction = COALESCE(?9, reaction),
           push_new_episode = COALESCE(?10, push_new_episode)`
      ).bind(c.get("uid"), followWatch, followComment, trackedComment, followFavorite, followRating, newFollower, listCreated, reaction, pushNewEpisode)
    );
  }
  await c.env.DB.batch(stmts);
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
