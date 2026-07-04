// Follows (issue #39): an asymmetric, Instagram-style social graph. You follow
// people; they don't have to follow back. Mounted behind requireAuth — every
// query is scoped to the signed-in user.
//
// Semantics:
//   * Following is one-directional and instant. Every account is public today
//     (users.is_private is never set), so a follow is always 'active' and needs
//     no approval. The 'pending' state and private-account follow requests stay
//     reserved for when is_private becomes user-settable.
//   * The activity feed and "also watching" are computed over the people you
//     FOLLOW (your followees). Someone who follows you but whom you don't follow
//     back never shows up there.
//   * User lookup is exact-match by username only (no prefix/substring search),
//     so the API never reveals more names than a caller already knows.
//   * Blocking and remove-a-follower are future work; unfollow covers this
//     iteration.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";

export const social = new Hono<AppEnv>();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Resolves a username (exact, case-insensitive) to a live user. The regex
// pre-check keeps garbage out of the query; NULL means "no such user".
async function findUser(c: Context<AppEnv>, username: string): Promise<{ id: number; username: string } | null> {
  if (!USERNAME_RE.test(username)) return null;
  return c.env.DB.prepare("SELECT id, username FROM users WHERE username = ?1 AND deleted_at IS NULL")
    .bind(username)
    .first<{ id: number; username: string }>();
}

// The people the signed-in user follows, as a CTE prefix. ?1 = uid.
const FOLLOWING_CTE = `WITH following(fid) AS (
  SELECT followee_id FROM follows WHERE follower_id = ?1 AND state = 'active'
)`;

// ---------- Follow graph ----------

// Everything the Following page needs in one round trip: who I follow and who
// follows me. Each follower row carries youFollow so the UI can offer a
// "Follow back" button.
social.get("/follows", async (c) => {
  const uid = c.get("uid");

  const following = await c.env.DB.prepare(
    `SELECT u.username, f.created_at AS since
     FROM follows f
     JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
     WHERE f.follower_id = ?1 AND f.state = 'active'
     ORDER BY f.created_at DESC`
  )
    .bind(uid)
    .all();

  const followers = await c.env.DB.prepare(
    `SELECT u.username, f.created_at AS since,
            EXISTS (SELECT 1 FROM follows me
                    WHERE me.follower_id = ?1 AND me.followee_id = f.follower_id AND me.state = 'active') AS youFollow
     FROM follows f
     JOIN users u ON u.id = f.follower_id AND u.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
     ORDER BY f.created_at DESC`
  )
    .bind(uid)
    .all();

  return c.json({
    following: following.results,
    followers: (followers.results as { username: string; since: string; youFollow: number }[]).map((r) => ({
      username: r.username,
      since: r.since,
      youFollow: !!r.youFollow,
    })),
  });
});

// Exact-username lookup with the relationship to the caller — powers the
// follow button on public profiles. Deliberately not a fuzzy search.
social.get("/search", async (c) => {
  const uid = c.get("uid");
  const user = await findUser(c, (c.req.query("q") ?? "").trim());
  if (!user) return c.json({ user: null });
  if (user.id === uid) return c.json({ user: { username: user.username, relation: "self", followsYou: false } });
  const edges = await c.env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2 AND state = 'active') AS iFollow,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1 AND state = 'active') AS followsYou`
  )
    .bind(uid, user.id)
    .first<{ iFollow: number; followsYou: number }>();
  return c.json({
    user: {
      username: user.username,
      relation: edges?.iFollow ? "following" : "none",
      followsYou: !!edges?.followsYou,
    },
  });
});

// Follow a user by username. Idempotent — following someone you already follow
// is a no-op. Public accounts follow instantly (state 'active').
social.post("/follow", async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({}));
  const target = await findUser(c, String(body.username ?? "").trim());
  if (!target) return c.json({ error: "No user with that username" }, 404);
  if (target.id === uid) return c.json({ error: "You can't follow yourself" }, 400);

  // is_private is never set today, so this is always an instant active follow.
  // When private accounts land, branch here to insert a 'pending' request.
  await c.env.DB.prepare(
    "INSERT INTO follows (follower_id, followee_id, state) VALUES (?1, ?2, 'active') ON CONFLICT DO NOTHING"
  )
    .bind(uid, target.id)
    .run();
  return c.json({ relation: "following" });
});

// Unfollow. Idempotent.
social.delete("/follow/:username", async (c) => {
  const uid = c.get("uid");
  const target = await findUser(c, c.req.param("username"));
  if (target && target.id !== uid) {
    await c.env.DB.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2")
      .bind(uid, target.id)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- What the people you follow are watching ----------

// Followees who have this show in their library ("also watching"), with their
// state so the UI can distinguish watching / caught up / wants to watch.
social.get("/also-watching/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const { results } = await c.env.DB.prepare(
    `${FOLLOWING_CTE}
     SELECT u.username, us.state
     FROM user_shows us
     JOIN following fo ON fo.fid = us.user_id
     JOIN users u ON u.id = us.user_id AND u.deleted_at IS NULL
     WHERE us.show_id = ?2 AND us.state != 'hidden'
     ORDER BY u.username COLLATE NOCASE`
  )
    .bind(c.get("uid"), id)
    .all();
  return c.json({ following: results });
});

// Feed entries older than the window fall off; keeps every branch of the
// UNION bounded regardless of how much history a followee has.
const FEED_WINDOW_MS = 30 * 24 * 3600 * 1000;
const FEED_LIMIT_DEFAULT = 20;
const FEED_LIMIT_MAX = 50;

// Activity from the people you follow: recent episode watches (grouped per
// person/show/day so a binge is one entry, not twenty), movie watches, show
// follows, and ratings — one UNION query, newest first, keyset-paginated.
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
    `${FOLLOWING_CTE}
     SELECT * FROM (
       SELECT 'watched' AS type, u.username, 'show' AS target_type, e.show_id AS target_id,
              s.title, s.poster_url AS poster, COUNT(*) AS count, NULL AS score,
              MAX(ue.watched_at) AS ts,
              'w:' || ue.user_id || ':s:' || e.show_id || ':' || date(ue.watched_at) AS k
       FROM user_episodes ue
       JOIN following fo ON fo.fid = ue.user_id
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
       JOIN following fo ON fo.fid = um.user_id
       JOIN users u ON u.id = um.user_id AND u.deleted_at IS NULL
       JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.state = 'watched' AND um.watched_at >= ?2 AND um.watched_at <= ?3

       UNION ALL
       SELECT 'followed', u.username, 'show', us.show_id, s.title, s.poster_url, 1, NULL,
              us.added_at, 'f:' || us.user_id || ':s:' || us.show_id
       FROM user_shows us
       JOIN following fo ON fo.fid = us.user_id
       JOIN users u ON u.id = us.user_id AND u.deleted_at IS NULL
       JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.state != 'hidden' AND us.added_at >= ?2 AND us.added_at <= ?3

       UNION ALL
       SELECT 'rated', u.username, r.target_type, r.target_id,
              COALESCE(s.title, m.title), COALESCE(s.poster_url, m.poster_url), 1, r.score,
              r.created_at, 'r:' || r.user_id || ':' || r.target_type || ':' || r.target_id
       FROM ratings r
       JOIN following fo ON fo.fid = r.user_id
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
