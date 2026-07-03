// Friends (issue #3): mutual friend graph plus what friends are watching.
// Mounted behind requireAuth — every query is scoped to the signed-in user.
//
// Privacy semantics:
//   * Friendship is mutual and always needs an explicit accept — there is no
//     instant-follow path, so users.is_private (the follow-approval flag from
//     0001) adds nothing extra here yet and keeps its meaning for a future
//     asymmetric-follow feature.
//   * Everything friend-related (activity feed, "also watching") is only ever
//     computed over ACCEPTED edges. A non-friend — and a pending requester —
//     sees nothing, whatever the target's is_private / profile_public flags.
//   * User lookup is exact-match by username only (no prefix/substring
//     search), so the API never reveals more names than a caller already
//     knows — the same information the public /u/:username route exposes.
//   * Blocking is future work (the social spec's only remove-a-follower path);
//     unfriending covers this iteration.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { nowIso } from "../lib/dates";
import { checkAchievements } from "../lib/achievements";

export const social = new Hono<AppEnv>();

// A new friendship counts for BOTH parties' achievements, but the mutation
// middleware only checks the caller — schedule the other side explicitly
// (issue #19).
function checkOtherParty(c: Context<AppEnv>, otherUid: number): void {
  c.executionCtx.waitUntil(checkAchievements(c.env, otherUid).catch((e) => console.error("achievement check failed", e)));
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Resolves a username (exact, case-insensitive) to a live user. The regex
// pre-check keeps garbage out of the query; NULL means "no such user".
async function findUser(c: Context<AppEnv>, username: string): Promise<{ id: number; username: string } | null> {
  if (!USERNAME_RE.test(username)) return null;
  return c.env.DB.prepare("SELECT id, username FROM users WHERE username = ?1 AND deleted_at IS NULL")
    .bind(username)
    .first<{ id: number; username: string }>();
}

// The signed-in user's accepted friends, as a CTE prefix. ?1 = uid.
const FRIENDS_CTE = `WITH friends(fid) AS (
  SELECT CASE WHEN requester_id = ?1 THEN addressee_id ELSE requester_id END
  FROM friendships
  WHERE status = 'accepted' AND ?1 IN (requester_id, addressee_id)
)`;

// ---------- Friend graph ----------

// Everything the Friends page needs in one round trip: accepted friends plus
// pending requests split into incoming (awaiting my answer) and outgoing.
social.get("/friends", async (c) => {
  const uid = c.get("uid");
  const { results } = await c.env.DB.prepare(
    `SELECT u.username, f.status, f.created_at, f.accepted_at, (f.requester_id = ?1) AS outgoing
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
     WHERE ?1 IN (f.requester_id, f.addressee_id) AND u.deleted_at IS NULL
     ORDER BY COALESCE(f.accepted_at, f.created_at) DESC`
  )
    .bind(uid)
    .all();
  const rows = results as { username: string; status: string; created_at: string; accepted_at: string | null; outgoing: number }[];
  return c.json({
    friends: rows
      .filter((r) => r.status === "accepted")
      .map((r) => ({ username: r.username, since: r.accepted_at ?? r.created_at })),
    incoming: rows.filter((r) => r.status === "pending" && !r.outgoing).map((r) => ({ username: r.username, at: r.created_at })),
    outgoing: rows.filter((r) => r.status === "pending" && r.outgoing).map((r) => ({ username: r.username, at: r.created_at })),
  });
});

// Exact-username lookup with the relationship to the caller — powers the
// friend button on public profiles. Deliberately not a fuzzy search.
social.get("/search", async (c) => {
  const uid = c.get("uid");
  const user = await findUser(c, (c.req.query("q") ?? "").trim());
  if (!user) return c.json({ user: null });
  if (user.id === uid) return c.json({ user: { username: user.username, relation: "self" } });
  const f = await c.env.DB.prepare(
    `SELECT status, requester_id FROM friendships
     WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`
  )
    .bind(uid, user.id)
    .first<{ status: string; requester_id: number }>();
  const relation = !f ? "none" : f.status === "accepted" ? "friends" : f.requester_id === uid ? "outgoing" : "incoming";
  return c.json({ user: { username: user.username, relation } });
});

// Send a friend request by username. Idempotent and inverse-aware:
//   no edge            → pending request created        → { status: 'outgoing' }
//   they already asked → auto-accept (mutual intent)    → { status: 'friends' }
//   already sent       → no-op                          → { status: 'outgoing' }
//   already friends    → no-op                          → { status: 'friends' }
social.post("/requests", async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({}));
  const target = await findUser(c, String(body.username ?? "").trim());
  if (!target) return c.json({ error: "No user with that username" }, 404);
  if (target.id === uid) return c.json({ error: "You can't friend yourself" }, 400);

  // Their pending request to me? Requesting back means both want it — accept.
  const accepted = await c.env.DB.prepare(
    "UPDATE friendships SET status = 'accepted', accepted_at = ?3 WHERE requester_id = ?2 AND addressee_id = ?1 AND status = 'pending'"
  )
    .bind(uid, target.id, nowIso())
    .run();
  if (accepted.meta.changes) {
    checkOtherParty(c, target.id);
    return c.json({ status: "friends" });
  }

  // Bare ON CONFLICT catches both the PK and the unordered-pair unique
  // index, so a concurrent inverse request can't create a duplicate edge.
  const inserted = await c.env.DB.prepare(
    "INSERT INTO friendships (requester_id, addressee_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING"
  )
    .bind(uid, target.id)
    .run();
  if (inserted.meta.changes) return c.json({ status: "outgoing" });

  // An edge already existed (repeat send, existing friendship, or an inverse
  // request that raced in between the UPDATE and the INSERT above).
  const existing = await c.env.DB.prepare(
    `SELECT status, requester_id FROM friendships
     WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`
  )
    .bind(uid, target.id)
    .first<{ status: string; requester_id: number }>();
  if (existing?.status === "accepted") return c.json({ status: "friends" });
  if (existing?.requester_id === uid) return c.json({ status: "outgoing" });
  if (existing) {
    // Their pending request won the race — but this caller was SENDING, so
    // both sides asked: retry the auto-accept instead of answering "incoming".
    const retried = await c.env.DB.prepare(
      "UPDATE friendships SET status = 'accepted', accepted_at = ?3 WHERE requester_id = ?2 AND addressee_id = ?1 AND status = 'pending'"
    )
      .bind(uid, target.id, nowIso())
      .run();
    if (retried.meta.changes) {
      checkOtherParty(c, target.id);
      return c.json({ status: "friends" });
    }
  }
  // No edge after all (or theirs vanished mid-race — they cancelled before
  // the retry landed): record this request. Best-effort, single retry depth.
  await c.env.DB.prepare(
    "INSERT INTO friendships (requester_id, addressee_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING"
  )
    .bind(uid, target.id)
    .run();
  return c.json({ status: "outgoing" });
});

// Accept a pending request FROM :username. 404s cover both "no such user"
// and "no pending request" — indistinguishable on purpose.
social.post("/requests/:username/accept", async (c) => {
  const uid = c.get("uid");
  const target = await findUser(c, c.req.param("username"));
  if (!target) return c.json({ error: "not found" }, 404);
  const { meta } = await c.env.DB.prepare(
    "UPDATE friendships SET status = 'accepted', accepted_at = ?3 WHERE requester_id = ?2 AND addressee_id = ?1 AND status = 'pending'"
  )
    .bind(uid, target.id, nowIso())
    .run();
  if (!meta.changes) return c.json({ error: "not found" }, 404);
  checkOtherParty(c, target.id);
  return c.json({ ok: true });
});

// Remove the pending request between me and :username — declines an
// incoming request or cancels my outgoing one. Idempotent.
social.delete("/requests/:username", async (c) => {
  const uid = c.get("uid");
  const target = await findUser(c, c.req.param("username"));
  if (target && target.id !== uid) {
    await c.env.DB.prepare(
      `DELETE FROM friendships WHERE status = 'pending'
       AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))`
    )
      .bind(uid, target.id)
      .run();
  }
  return c.json({ ok: true });
});

// Unfriend. Idempotent.
social.delete("/friends/:username", async (c) => {
  const uid = c.get("uid");
  const target = await findUser(c, c.req.param("username"));
  if (target && target.id !== uid) {
    await c.env.DB.prepare(
      `DELETE FROM friendships WHERE status = 'accepted'
       AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))`
    )
      .bind(uid, target.id)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- What friends are watching ----------

// Friends who have this show in their library ("also watching"), with their
// state so the UI can distinguish watching / caught up / wants to watch.
social.get("/also-watching/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const { results } = await c.env.DB.prepare(
    `${FRIENDS_CTE}
     SELECT u.username, us.state
     FROM user_shows us
     JOIN friends f ON f.fid = us.user_id
     JOIN users u ON u.id = us.user_id AND u.deleted_at IS NULL
     WHERE us.show_id = ?2 AND us.state != 'hidden'
     ORDER BY u.username COLLATE NOCASE`
  )
    .bind(c.get("uid"), id)
    .all();
  return c.json({ friends: results });
});

// Feed entries older than the window fall off; keeps every branch of the
// UNION bounded regardless of how much history a friend has.
const FEED_WINDOW_MS = 30 * 24 * 3600 * 1000;
const FEED_LIMIT_DEFAULT = 20;
const FEED_LIMIT_MAX = 50;

// Friends activity: recent episode watches (grouped per friend/show/day so a
// binge is one entry, not twenty), movie watches, show follows, and ratings —
// one UNION query, newest first, keyset-paginated.
//
// Pagination cursor is the opaque "ts|k" pair: k is a stable, per-row unique
// tie-break key each branch synthesizes, and the page condition compares
// (ts, k) lexicographically — rows that share the boundary timestamp are kept
// instead of being skipped forever, and grouped binge entries paginate by
// their group ts (HAVING) so a page boundary can't split one binge in two.
//
// Timestamps are stored/compared as UTC ISO 8601 throughout (schema
// convention); the client renders them in the viewer's profile timezone.
// The per-day binge grouping buckets on the UTC date — a coarse grouping
// key, not a displayed date.
social.get("/activity", async (c) => {
  const uid = c.get("uid");
  const since = new Date(Date.now() - FEED_WINDOW_MS).toISOString();

  // "ts|k" cursor. A bad/missing ts falls back to "everything"; a missing k
  // (never emitted by us) degrades to plain ts-keyset.
  let beforeTs = "9999-12-31T23:59:59.999Z";
  let beforeKey = "";
  const beforeRaw = c.req.query("before");
  if (beforeRaw) {
    const sep = beforeRaw.indexOf("|");
    const tsPart = sep === -1 ? beforeRaw : beforeRaw.slice(0, sep);
    const t = Date.parse(tsPart);
    if (!Number.isNaN(t)) {
      beforeTs = new Date(t).toISOString();
      if (sep !== -1) beforeKey = beforeRaw.slice(sep + 1);
    }
  }
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, FEED_LIMIT_MAX) : FEED_LIMIT_DEFAULT;

  const { results } = await c.env.DB.prepare(
    `${FRIENDS_CTE}
     SELECT * FROM (
       SELECT 'watched' AS type, u.username, 'show' AS target_type, e.show_id AS target_id,
              s.title, s.poster_url AS poster, COUNT(*) AS count, NULL AS score,
              MAX(ue.watched_at) AS ts,
              'w:' || ue.user_id || ':s:' || e.show_id || ':' || date(ue.watched_at) AS k
       FROM user_episodes ue
       JOIN friends f ON f.fid = ue.user_id
       JOIN users u ON u.id = ue.user_id AND u.deleted_at IS NULL
       JOIN episodes e ON e.id = ue.episode_id
       JOIN shows s ON s.tmdb_id = e.show_id
       WHERE ue.watched_at >= ?2
       GROUP BY ue.user_id, e.show_id, date(ue.watched_at)
       HAVING MAX(ue.watched_at) <= ?3

       UNION ALL
       SELECT 'watched', u.username, 'movie', um.movie_id, m.title, m.poster_url, 1, NULL,
              um.watched_at, 'w:' || um.user_id || ':m:' || um.movie_id
       FROM user_movies um
       JOIN friends f ON f.fid = um.user_id
       JOIN users u ON u.id = um.user_id AND u.deleted_at IS NULL
       JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.state = 'watched' AND um.watched_at >= ?2 AND um.watched_at <= ?3

       UNION ALL
       SELECT 'followed', u.username, 'show', us.show_id, s.title, s.poster_url, 1, NULL,
              us.added_at, 'f:' || us.user_id || ':s:' || us.show_id
       FROM user_shows us
       JOIN friends f ON f.fid = us.user_id
       JOIN users u ON u.id = us.user_id AND u.deleted_at IS NULL
       JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.state != 'hidden' AND us.added_at >= ?2 AND us.added_at <= ?3

       UNION ALL
       SELECT 'rated', u.username, r.target_type, r.target_id,
              COALESCE(s.title, m.title), COALESCE(s.poster_url, m.poster_url), 1, r.score,
              r.created_at, 'r:' || r.user_id || ':' || r.target_type || ':' || r.target_id
       FROM ratings r
       JOIN friends f ON f.fid = r.user_id
       JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
       LEFT JOIN shows s ON r.target_type = 'show' AND s.tmdb_id = r.target_id
       LEFT JOIN movies m ON r.target_type = 'movie' AND m.tmdb_id = r.target_id
       WHERE r.target_type IN ('show', 'movie') AND r.score IS NOT NULL
         AND r.created_at >= ?2 AND r.created_at <= ?3
     )
     WHERE ts < ?3 OR (ts = ?3 AND k < ?5)
     ORDER BY ts DESC, k DESC
     LIMIT ?4`
  )
    .bind(uid, since, beforeTs, limit, beforeKey)
    .all();

  const items = results as { ts: string; k: string }[];
  const last = items[items.length - 1];
  return c.json({
    items,
    // More MIGHT exist when the page came back full; the client stops when a
    // follow-up page is empty.
    nextCursor: items.length === limit ? `${last.ts}|${last.k}` : null,
  });
});
