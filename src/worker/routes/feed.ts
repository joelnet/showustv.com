// The Instagram-style feed: posts from the people you follow (plus your own),
// newest sitting first, with emoji reactions. Comments on posts ride the
// shared comment system (routes/comments.ts, target_type 'post'). Posts are
// materialized by lib/feed-posts.ts off the watch routes.
//
// TEMPORARY: the whole router is gated to FEED_BETA_USERS (shared/constants
// .ts) — everyone else gets the same 404 an unknown route would, so the
// feature's existence doesn't leak. Delete the middleware with the constant.

import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { canSeePost, isFeedBetaUser } from "../lib/feed-posts";
import { notifyPostReaction } from "../lib/notifications";
import { FOLLOWING_CTE } from "./social";
import { POST_REACTION_SET } from "../../shared/post-reactions";
import type { FeedPost } from "../../shared/feed";

export const feed = new Hono<AppEnv>();

feed.use("*", async (c, next) => {
  if (!(await isFeedBetaUser(c.env, c.get("uid")))) return c.json({ error: "not found" }, 404);
  await next();
  c.res.headers.set("cache-control", "no-store");
});

const PAGE_DEFAULT = 20;
const PAGE_MAX = 30;

interface PostRow {
  id: number;
  user_id: number;
  username: string;
  target_type: "show" | "movie";
  target_id: number;
  first_at: string;
  last_at: string;
  rewatch: number;
  title: string | null;
  poster: string | null;
  backdrop: string | null;
  ep_id: number | null;
  ep_season: number | null;
  ep_number: number | null;
  ep_title: string | null;
  ep_still: string | null;
  comment_count: number;
  my_reaction: string | null;
}

// The columns every post payload needs, resolved live (titles, stills,
// counts) so a later TMDB refresh shows through. The latest episode is the
// card's image; comment_count hides deleted comments and ghosts the way the
// thread itself does; ?1 is always the viewer.
const POST_SELECT = `
  SELECT fp.id, fp.user_id, u.username, fp.target_type, fp.target_id, fp.first_at, fp.last_at, fp.rewatch,
         COALESCE(s.title, m.title) AS title,
         COALESCE(s.poster_url, m.poster_url) AS poster,
         s.backdrop_url AS backdrop,
         le.id AS ep_id, le.season_number AS ep_season, le.number AS ep_number,
         le.title AS ep_title, le.still_url AS ep_still,
         (SELECT COUNT(*) FROM comments c JOIN users cu ON cu.id = c.user_id
           WHERE c.target_type = 'post' AND c.target_id = fp.id AND c.deleted_at IS NULL
             AND (cu.shadow_banned = 0 OR cu.id = ?1)) AS comment_count,
         (SELECT pr.emoji FROM post_reactions pr WHERE pr.post_id = fp.id AND pr.user_id = ?1) AS my_reaction
  FROM feed_posts fp
  JOIN users u ON u.id = fp.user_id AND u.deleted_at IS NULL AND (u.shadow_banned = 0 OR u.id = ?1)
  LEFT JOIN shows  s ON fp.target_type = 'show'  AND s.tmdb_id = fp.target_id
  LEFT JOIN movies m ON fp.target_type = 'movie' AND m.tmdb_id = fp.target_id
  LEFT JOIN episodes le ON le.id = (
    SELECT fpe.episode_id FROM feed_post_episodes fpe JOIN episodes e2 ON e2.id = fpe.episode_id
    WHERE fpe.post_id = fp.id
    ORDER BY fpe.watched_at DESC, e2.season_number DESC, e2.number DESC LIMIT 1)`;

// A show the owner hid is private activity, off the feed entirely.
const NOT_HIDDEN = `(fp.target_type = 'movie' OR NOT EXISTS (
  SELECT 1 FROM user_shows h WHERE h.user_id = fp.user_id AND h.show_id = fp.target_id AND h.hidden = 1))`;

// Attach each post's episode list and reaction tallies (two IN-list queries
// over at most a page of ids) and shape the API object.
async function shapePosts(env: Env, uid: number, rows: PostRow[]): Promise<FeedPost[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map((_, i) => `?${i + 1}`).join(",");
  const [epR, rxR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT fpe.post_id, e.season_number AS season, e.number
       FROM feed_post_episodes fpe JOIN episodes e ON e.id = fpe.episode_id
       WHERE fpe.post_id IN (${ph})
       ORDER BY fpe.post_id, e.season_number, e.number`
    ).bind(...ids),
    env.DB.prepare(
      `SELECT pr.post_id, pr.emoji, COUNT(*) AS n
       FROM post_reactions pr JOIN users ru ON ru.id = pr.user_id AND ru.deleted_at IS NULL
       WHERE pr.post_id IN (${ph})
       GROUP BY pr.post_id, pr.emoji
       ORDER BY pr.post_id, n DESC, MIN(pr.created_at)`
    ).bind(...ids),
  ]);
  const episodes = new Map<number, { season: number; number: number }[]>();
  for (const e of epR.results as { post_id: number; season: number; number: number }[]) {
    const list = episodes.get(e.post_id) ?? [];
    list.push({ season: e.season, number: e.number });
    episodes.set(e.post_id, list);
  }
  const reactions = new Map<number, { emoji: string; count: number }[]>();
  for (const r of rxR.results as { post_id: number; emoji: string; n: number }[]) {
    const list = reactions.get(r.post_id) ?? [];
    list.push({ emoji: r.emoji, count: r.n });
    reactions.set(r.post_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    mine: r.user_id === uid,
    kind: r.target_type,
    targetId: r.target_id,
    title: r.title ?? "",
    poster: r.poster,
    backdrop: r.backdrop,
    firstAt: r.first_at,
    lastAt: r.last_at,
    rewatch: !!r.rewatch,
    episodes: episodes.get(r.id) ?? [],
    latestEpisode:
      r.ep_id != null && r.ep_season != null && r.ep_number != null
        ? { id: r.ep_id, season: r.ep_season, number: r.ep_number, title: r.ep_title, still: r.ep_still }
        : null,
    reactions: reactions.get(r.id) ?? [],
    myReaction: r.my_reaction,
    commentCount: r.comment_count,
  }));
}

// Current reaction tallies for one post, the authoritative state the
// reaction endpoint hands back so the client's optimistic math self-corrects.
async function reactionState(env: Env, uid: number, postId: number) {
  const [mineR, allR] = await env.DB.batch([
    env.DB.prepare("SELECT emoji FROM post_reactions WHERE post_id = ?1 AND user_id = ?2").bind(postId, uid),
    env.DB.prepare(
      `SELECT pr.emoji, COUNT(*) AS n
       FROM post_reactions pr JOIN users ru ON ru.id = pr.user_id AND ru.deleted_at IS NULL
       WHERE pr.post_id = ?1 GROUP BY pr.emoji ORDER BY n DESC, MIN(pr.created_at)`
    ).bind(postId),
  ]);
  return {
    myReaction: (mineR.results[0] as { emoji: string } | undefined)?.emoji ?? null,
    reactions: (allR.results as { emoji: string; n: number }[]).map((r) => ({ emoji: r.emoji, count: r.n })),
  };
}

// GET /feed?before=<lastAt>|<id>&limit=N — the viewer's own posts plus those
// of the people they follow under the feed visibility rule (FOLLOWING_CTE:
// profile public or mutual). Keyset on (last_at, id) so a page boundary
// never skips or repeats a post that shares a timestamp.
feed.get("/", async (c) => {
  const uid = c.get("uid");
  let beforeTs: string | null = null;
  let beforeId = 0;
  const beforeRaw = c.req.query("before");
  if (beforeRaw) {
    const sep = beforeRaw.indexOf("|");
    const t = Date.parse(sep === -1 ? beforeRaw : beforeRaw.slice(0, sep));
    if (!Number.isNaN(t)) {
      beforeTs = new Date(t).toISOString();
      const idPart = Number(sep === -1 ? 0 : beforeRaw.slice(sep + 1));
      beforeId = Number.isInteger(idPart) ? idPart : 0;
    }
  }
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, PAGE_MAX) : PAGE_DEFAULT;

  const { results } = await c.env.DB.prepare(
    `${FOLLOWING_CTE},
     visible(vid) AS (SELECT fid FROM following UNION ALL SELECT ?1)
     ${POST_SELECT}
     WHERE fp.user_id IN (SELECT vid FROM visible)
       AND ${NOT_HIDDEN}
       AND (?2 IS NULL OR fp.last_at < ?2 OR (fp.last_at = ?2 AND fp.id < ?3))
     ORDER BY fp.last_at DESC, fp.id DESC
     LIMIT ?4`
  )
    .bind(uid, beforeTs, beforeId, limit)
    .all<PostRow>();
  const posts = await shapePosts(c.env, uid, results);
  const last = posts[posts.length - 1];
  return c.json({
    posts,
    // More MIGHT exist when the page came back full; the client stops when a
    // follow-up page is empty (activity-feed convention).
    nextCursor: posts.length === limit && last ? `${last.lastAt}|${last.id}` : null,
  });
});

// One post, for the /feed/:id page (the comment thread lives there). The
// visibility probe answers "not found" for anything the viewer may not see.
feed.get("/posts/:id", async (c) => {
  const uid = c.get("uid");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  if (!(await canSeePost(c.env, uid, id))) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(`${POST_SELECT} WHERE fp.id = ?2`).bind(uid, id).all<PostRow>();
  const [post] = await shapePosts(c.env, uid, results);
  if (!post) return c.json({ error: "not found" }, 404);
  return c.json({ post });
});

// PUT /feed/posts/:id/reaction { emoji | null } — set/replace with an emoji
// from the curated list, clear with null (the activity-reaction pattern). One
// per viewer per post. Reacting to your own post is refused like the rail's
// reactions are. Notifies the owner only when the row actually changed.
feed.put("/posts/:id/reaction", async (c) => {
  const uid = c.get("uid");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const emoji = body.emoji == null ? null : String(body.emoji);
  if (emoji != null && !POST_REACTION_SET.has(emoji)) return c.json({ error: "unknown reaction" }, 400);

  const seen = await canSeePost(c.env, uid, id);
  if (!seen) return c.json({ error: "not found" }, 404);
  if (seen.ownerId === uid) return c.json({ error: "You can't react to your own post" }, 400);

  if (emoji == null) {
    await c.env.DB.prepare("DELETE FROM post_reactions WHERE post_id = ?1 AND user_id = ?2").bind(id, uid).run();
  } else {
    // The WHERE makes re-picking the current emoji a genuine no-op, so
    // meta.changes detects real transitions only.
    const { meta } = await c.env.DB.prepare(
      `INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?1, ?2, ?3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET emoji = excluded.emoji
       WHERE emoji != excluded.emoji`
    )
      .bind(id, uid, emoji)
      .run();
    if (meta.changes) {
      c.executionCtx.waitUntil(
        notifyPostReaction(c.env, uid, seen.ownerId, id, emoji).catch((e) => console.error("notify failed", e))
      );
    }
  }
  return c.json(await reactionState(c.env, uid, id));
});
