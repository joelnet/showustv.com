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
import { animeCond } from "../lib/library";
import { notifyUserOfFollow } from "../lib/notifications";

export const social = new Hono<AppEnv>();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const TASTE_GRAPH_MUTUAL_LIMIT = 80;
const TASTE_GRAPH_MEDIA_LIMIT = 120;
const TASTE_GRAPH_CATEGORY_RESERVE = 20;

// Resolves a username (exact, case-insensitive) to a live user. The regex
// pre-check keeps garbage out of the query; NULL means "no such user".
async function findUser(c: Context<AppEnv>, username: string): Promise<{ id: number; username: string } | null> {
  if (!USERNAME_RE.test(username)) return null;
  return c.env.DB.prepare("SELECT id, username FROM users WHERE username = ?1 AND deleted_at IS NULL")
    .bind(username)
    .first<{ id: number; username: string }>();
}

// The people the signed-in user follows WHOSE ACTIVITY THIS VIEWER MAY SEE,
// as a CTE prefix. ?1 = uid. Follows are instant and self-granted, so the
// follow edge alone must not unlock anything (issue #205); a followee's
// watch/rating activity is served only under the visibility rule from
// issues #202/#184: their profile is visible to this viewer — public, or
// private-but-mutual (the owner following the viewer back is the deliberate
// unlock signal). The separate activity_public gate was dropped (issue #308):
// #249 removed the eye toggle that set that flag, freezing it, so gating on it
// permanently hid the activity of any user whose flag was 0 from their
// followers/mutuals — the exact symptom in that issue.
const FOLLOWING_CTE = `WITH following(fid) AS (
  SELECT f.followee_id FROM follows f
  JOIN users fu ON fu.id = f.followee_id
  WHERE f.follower_id = ?1 AND f.state = 'active'
    AND (fu.profile_public = 1 OR EXISTS (
      SELECT 1 FROM follows r
      WHERE r.follower_id = f.followee_id AND r.followee_id = ?1 AND r.state = 'active'))
)`;

// ---------- Follow graph ----------

// Everything the Following page needs in one request: mutuals (we follow each
// other), who I follow but who doesn't follow back, and who follows me but whom
// I don't follow back. The three lists are disjoint (issue #288) — a mutual
// appears only under Mutuals, never duplicated into Following or Followers — so
// each account shows in exactly one section and the section counts don't
// double-count.
social.get("/follows", async (c) => {
  const uid = c.get("uid");

  // Mutuals (issue #130): the intersection of following and followers. `since`
  // is the later of the two follow dates — when the pair became mutual.
  const mutuals = await c.env.DB.prepare(
    `SELECT u.username, MAX(f.created_at, r.created_at) AS since
     FROM follows f
     JOIN follows r ON r.follower_id = f.followee_id AND r.followee_id = ?1 AND r.state = 'active'
     JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
     WHERE f.follower_id = ?1 AND f.state = 'active'
     ORDER BY since DESC`
  )
    .bind(uid)
    .all();

  // Following minus mutuals: people I follow who do NOT follow me back (issue
  // #288). The NOT EXISTS drops any followee with a reciprocal edge — those
  // belong to the Mutuals list above.
  const following = await c.env.DB.prepare(
    `SELECT u.username, f.created_at AS since
     FROM follows f
     JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
     WHERE f.follower_id = ?1 AND f.state = 'active'
       AND NOT EXISTS (SELECT 1 FROM follows r
                       WHERE r.follower_id = f.followee_id AND r.followee_id = ?1 AND r.state = 'active')
     ORDER BY f.created_at DESC`
  )
    .bind(uid)
    .all();

  // Followers minus mutuals: people who follow me whom I do NOT follow back
  // (issue #288). The NOT EXISTS drops anyone I already follow — those are
  // mutuals. Every row here is therefore non-mutual, so youFollow is always
  // false; it's kept for response-shape stability and drives the client's
  // "Follow back" button.
  const followers = await c.env.DB.prepare(
    `SELECT u.username, f.created_at AS since
     FROM follows f
     JOIN users u ON u.id = f.follower_id AND u.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
       AND NOT EXISTS (SELECT 1 FROM follows me
                       WHERE me.follower_id = ?1 AND me.followee_id = f.follower_id AND me.state = 'active')
     ORDER BY f.created_at DESC`
  )
    .bind(uid)
    .all();

  return c.json({
    mutuals: mutuals.results,
    following: following.results,
    followers: (followers.results as { username: string; since: string }[]).map((r) => ({
      username: r.username,
      since: r.since,
      youFollow: false,
    })),
  });
});

// Movies, TV shows, and anime the signed-in user has watched in common with
// reciprocal follows. A show enters the graph only after both people have
// watched at least one episode; merely saving it for later is not enough.
// This is intentionally a mutual-only surface: a one-way follow must never
// turn into bulk access to somebody else's watch history. The response is
// also deliberately minimal. It carries membership and favorite state, but
// no watch timestamps, ratings, email addresses, or numeric user ids.
social.get("/taste-graph", async (c) => {
  const uid = c.get("uid");

  type MutualRow = {
    username: string;
    since: string;
    total_count: number;
  };
  type ConnectionRow = {
    target_type: "movie" | "show";
    category: "movie" | "show" | "anime";
    target_id: number;
    title: string;
    poster: string | null;
    release_year: string | null;
    my_favorite: number;
    mutual_viewer_count: number;
    mutual_favorite_count: number;
    username: string;
    their_favorite: number;
  };

  const mutualsSql = `WITH mutuals AS (
    SELECT u.id, u.username, MAX(f.created_at, r.created_at) AS since
    FROM follows f
    JOIN follows r
      ON r.follower_id = f.followee_id
     AND r.followee_id = ?1
     AND r.state = 'active'
    JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
    WHERE f.follower_id = ?1 AND f.state = 'active'
  )
  SELECT username, since, COUNT(*) OVER () AS total_count
  FROM mutuals
  ORDER BY since DESC, username COLLATE NOCASE
  LIMIT ?2`;

  const connectionsSql = `WITH mutuals AS (
    SELECT u.id, u.username, MAX(f.created_at, r.created_at) AS since
    FROM follows f
    JOIN follows r
      ON r.follower_id = f.followee_id
     AND r.followee_id = ?1
     AND r.state = 'active'
    JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
    WHERE f.follower_id = ?1 AND f.state = 'active'
    ORDER BY since DESC, u.username COLLATE NOCASE
    LIMIT ?2
  ),
  my_media(target_type, target_id) AS (
    SELECT 'movie', movie_id
    FROM user_movies
    WHERE user_id = ?1 AND state = 'watched'
    UNION ALL
    SELECT 'show', e.show_id
    FROM user_episodes ue
    JOIN episodes e ON e.id = ue.episode_id
    JOIN user_shows us
      ON us.user_id = ue.user_id
     AND us.show_id = e.show_id
     AND us.hidden = 0
     AND us.state != 'hidden'
    WHERE ue.user_id = ?1
    GROUP BY e.show_id
  ),
  favorites AS (
    SELECT DISTINCT l.user_id, li.target_type, li.target_id
    FROM custom_lists l
    JOIN custom_list_items li ON li.list_id = l.id
    WHERE l.kind = 'favorites'
      AND li.target_type IN ('movie', 'show')
      AND (l.user_id = ?1 OR EXISTS (SELECT 1 FROM mutuals mu WHERE mu.id = l.user_id))
  ),
  mutual_media(user_id, username, target_type, target_id) AS (
    SELECT mu.id, mu.username, 'movie', um.movie_id
    FROM mutuals mu
    JOIN user_movies um ON um.user_id = mu.id AND um.state = 'watched'
    UNION ALL
    SELECT mu.id, mu.username, 'show', e.show_id
    FROM mutuals mu
    JOIN user_episodes ue ON ue.user_id = mu.id
    JOIN episodes e ON e.id = ue.episode_id
    JOIN user_shows us
      ON us.user_id = mu.id
     AND us.show_id = e.show_id
     AND us.hidden = 0
     AND us.state != 'hidden'
    GROUP BY mu.id, mu.username, e.show_id
  ),
  shared AS (
    SELECT theirs.username, theirs.target_type, theirs.target_id,
           CASE WHEN their_fav.target_id IS NULL THEN 0 ELSE 1 END AS their_favorite
    FROM mutual_media theirs
    JOIN my_media mine
      ON mine.target_type = theirs.target_type
     AND mine.target_id = theirs.target_id
    LEFT JOIN favorites their_fav
      ON their_fav.user_id = theirs.user_id
     AND their_fav.target_type = theirs.target_type
     AND their_fav.target_id = theirs.target_id
  ),
  ranked AS (
    SELECT shared.target_type, shared.target_id,
           COUNT(*) AS mutual_viewer_count,
           SUM(shared.their_favorite) AS mutual_favorite_count,
           CASE WHEN my_fav.target_id IS NULL THEN 0 ELSE 1 END AS my_favorite,
           COUNT(*) +
             (2 * SUM(shared.their_favorite)) +
             CASE WHEN my_fav.target_id IS NULL THEN 0 ELSE 2 END +
             CASE WHEN my_fav.target_id IS NULL THEN 0 ELSE 3 * SUM(shared.their_favorite) END AS relevance
    FROM shared
    LEFT JOIN favorites my_fav
      ON my_fav.user_id = ?1
     AND my_fav.target_type = shared.target_type
     AND my_fav.target_id = shared.target_id
    GROUP BY shared.target_type, shared.target_id, my_fav.target_id
  ),
  catalog AS (
    SELECT 'movie' AS target_type, m.tmdb_id AS target_id, m.title,
           m.poster_url AS poster,
           CASE WHEN LENGTH(m.release_date) >= 4 THEN SUBSTR(m.release_date, 1, 4) ELSE NULL END AS release_year,
           CASE WHEN ${animeCond("m")} THEN 'anime' ELSE 'movie' END AS category
    FROM movies m
    UNION ALL
    SELECT 'show' AS target_type, s.tmdb_id AS target_id, s.title,
           s.poster_url AS poster,
           CASE WHEN LENGTH(s.first_air_date) >= 4 THEN SUBSTR(s.first_air_date, 1, 4) ELSE NULL END AS release_year,
           CASE WHEN ${animeCond("s")} THEN 'anime' ELSE 'show' END AS category
    FROM shows s
  ),
  categorized AS (
    SELECT ranked.*, catalog.title, catalog.poster, catalog.release_year, catalog.category,
           ROW_NUMBER() OVER (
             PARTITION BY catalog.category
             ORDER BY ranked.relevance DESC, ranked.mutual_viewer_count DESC,
                      catalog.title COLLATE NOCASE, ranked.target_id
           ) AS category_rank
    FROM ranked
    JOIN catalog
      ON catalog.target_type = ranked.target_type
     AND catalog.target_id = ranked.target_id
  ),
  selected AS (
    SELECT *
    FROM categorized
    ORDER BY CASE WHEN category_rank <= ?4 THEN 0 ELSE 1 END,
             relevance DESC, mutual_viewer_count DESC, title COLLATE NOCASE, target_id
    LIMIT ?3
  )
  SELECT selected.target_type, selected.category, selected.target_id,
         selected.title, selected.poster, selected.release_year,
         selected.my_favorite, selected.mutual_viewer_count, selected.mutual_favorite_count,
         shared.username, shared.their_favorite
  FROM selected
  JOIN shared
    ON shared.target_type = selected.target_type
   AND shared.target_id = selected.target_id
  ORDER BY selected.relevance DESC, selected.mutual_viewer_count DESC,
           selected.title COLLATE NOCASE, shared.username COLLATE NOCASE`;

  const [mutualsResult, connectionsResult] = await c.env.DB.batch<MutualRow | ConnectionRow>([
    c.env.DB.prepare(mutualsSql).bind(uid, TASTE_GRAPH_MUTUAL_LIMIT),
    c.env.DB
      .prepare(connectionsSql)
      .bind(uid, TASTE_GRAPH_MUTUAL_LIMIT, TASTE_GRAPH_MEDIA_LIMIT, TASTE_GRAPH_CATEGORY_RESERVE),
  ]);

  const mutualRows = mutualsResult.results as MutualRow[];
  const connectionRows = connectionsResult.results as ConnectionRow[];
  const mediaMap = new Map<
    string,
    {
      id: number;
      type: "movie" | "show";
      category: "movie" | "show" | "anime";
      title: string;
      poster: string | null;
      releaseYear: number | null;
      mutualViewerCount: number;
      mutualFavoriteCount: number;
      myFavorite: boolean;
      mutualFavorite: boolean;
    }
  >();

  const links = connectionRows.map((row) => {
    const key = `${row.target_type}:${row.target_id}`;
    if (!mediaMap.has(key)) {
      mediaMap.set(key, {
        id: row.target_id,
        type: row.target_type,
        category: row.category,
        title: row.title,
        poster: row.poster,
        releaseYear: row.release_year == null ? null : Number(row.release_year),
        mutualViewerCount: row.mutual_viewer_count,
        mutualFavoriteCount: row.mutual_favorite_count,
        myFavorite: !!row.my_favorite,
        mutualFavorite: !!row.my_favorite && row.mutual_favorite_count > 0,
      });
    }
    return {
      person: row.username,
      targetType: row.target_type,
      targetId: row.target_id,
      favorite: !!row.their_favorite,
    };
  });

  const media = Array.from(mediaMap.values());
  const totalMutuals = mutualRows[0]?.total_count ?? 0;

  // The service worker must never persist a viewer-specific aggregation that
  // can include private-profile mutuals. This mirrors the cache hygiene on
  // the public profile/library gates.
  c.header("Cache-Control", "private, no-store");
  return c.json({
    summary: {
      mutualCount: totalMutuals,
      mutualsShown: mutualRows.length,
      sharedTitleCount: media.length,
      movieCount: media.filter((item) => item.category === "movie").length,
      showCount: media.filter((item) => item.category === "show").length,
      animeCount: media.filter((item) => item.category === "anime").length,
      mutualFavoriteCount: media.filter((item) => item.mutualFavorite).length,
      truncated: totalMutuals > mutualRows.length,
    },
    mutuals: mutualRows.map((row) => ({ username: row.username })),
    media,
    links,
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
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO follows (follower_id, followee_id, state) VALUES (?1, ?2, 'active') ON CONFLICT DO NOTHING"
  )
    .bind(uid, target.id)
    .run();
  // Notify the followee (issue #273), off the response path — the same hook
  // shape as the watch/favorite routes. meta.changes detects the transition
  // INTO following: the ON CONFLICT no-op reports 0 changes, so re-following
  // someone you already follow never re-notifies.
  if (meta.changes) {
    c.executionCtx.waitUntil(
      notifyUserOfFollow(c.env, uid, target.id).catch((e) => console.error("notify failed", e))
    );
  }
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
     WHERE us.show_id = ?2 AND us.state != 'hidden' AND us.hidden = 0
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
         -- The watcher hid this show (issue #260): their episode watches on
         -- it are private activity, off the feed entirely.
         AND NOT EXISTS (SELECT 1 FROM user_shows h
                         WHERE h.user_id = ue.user_id AND h.show_id = e.show_id AND h.hidden = 1)
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
       WHERE us.state != 'hidden' AND us.hidden = 0 AND us.added_at >= ?2 AND us.added_at <= ?3

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
         -- A rating on a hidden show (issue #260) would out it just like a
         -- watch; movie ratings pass through (hiding is per-show).
         AND NOT EXISTS (SELECT 1 FROM user_shows h
                         WHERE r.target_type = 'show'
                           AND h.user_id = r.user_id AND h.show_id = r.target_id AND h.hidden = 1)
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
