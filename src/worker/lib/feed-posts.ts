// Feed posts: the materialized "what people you follow are watching" entries
// behind /feed. A post is one user's watches of ONE show — one or more
// episodes, grouped per sitting — or ONE movie play. Posts are rows (not a
// derived view of the plays tables) so each has a stable id for reactions,
// comments, and notification deep links.
//
// Only the single-episode watch and the movie watch routes create posts; the
// bulk season/show sweeps and the importer are history backfill and never do
// (the same rule the follow-watch notification applies). Every path that
// removes a play reconciles instead: an episode stays in its post only while
// the EXACT play it recorded still exists, so un-ticks, single-play removals,
// round undos and full unwatches all funnel through one helper.
//
// All of these run off the response path via c.executionCtx.waitUntil, like
// the notification fan-outs.

import type { Env } from "../env";

// A new single-episode watch joins the watcher's latest post for that show
// while it lands within this gap of the post's last watch — one episode a
// night is one post a night; a late binge across midnight stays one post.
export const POST_GAP_MS = 8 * 3600 * 1000;

// Record a single-episode watch. Runs AFTER the play row is inserted, so the
// rewatch probe uses strict `<` on the timestamp to look past this play.
// Known gap: two watches landing milliseconds apart (an offline-queue drain)
// can both miss the latest-post probe and open two posts. Tolerable.
export async function recordEpisodeWatch(
  env: Env,
  uid: number,
  showId: number,
  episodeId: number,
  watchedAt: string,
  seasonNumber: number
): Promise<void> {
  if (seasonNumber <= 0) return; // specials never post, matching the rail
  const [rwR, latestR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM user_episode_plays p
                      WHERE p.user_id = ?1 AND p.episode_id = ?2 AND p.watched_at < ?3) AS rw`
    ).bind(uid, episodeId, watchedAt),
    env.DB.prepare(
      `SELECT id, last_at FROM feed_posts
       WHERE user_id = ?1 AND target_type = 'show' AND target_id = ?2
       ORDER BY last_at DESC LIMIT 1`
    ).bind(uid, showId),
  ]);
  const isRewatch = !!(rwR.results[0] as { rw: number } | undefined)?.rw;
  const latest = latestR.results[0] as { id: number; last_at: string } | undefined;

  if (latest && Math.abs(Date.parse(watchedAt) - Date.parse(latest.last_at)) <= POST_GAP_MS) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO feed_post_episodes (post_id, episode_id, watched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (post_id, episode_id) DO UPDATE SET watched_at = MAX(watched_at, excluded.watched_at)`
      ).bind(latest.id, episodeId, watchedAt),
      // rewatch stays 1 only while every play in the post is a rewatch.
      env.DB.prepare(
        `UPDATE feed_posts SET last_at = MAX(last_at, ?2), first_at = MIN(first_at, ?2),
                               rewatch = CASE WHEN ?3 THEN rewatch ELSE 0 END
         WHERE id = ?1`
      ).bind(latest.id, watchedAt, isRewatch ? 1 : 0),
    ]);
    return;
  }

  const created = await env.DB.prepare(
    `INSERT INTO feed_posts (user_id, target_type, target_id, first_at, last_at, rewatch)
     VALUES (?1, 'show', ?2, ?3, ?3, ?4) RETURNING id`
  )
    .bind(uid, showId, watchedAt, isRewatch ? 1 : 0)
    .first<{ id: number }>();
  if (!created) return;
  await env.DB.prepare("INSERT INTO feed_post_episodes (post_id, episode_id, watched_at) VALUES (?1, ?2, ?3)")
    .bind(created.id, episodeId, watchedAt)
    .run();
}

// Record a movie watch: one post per dated play. The NOT EXISTS absorbs an
// offline-queue replay of the same mark (same watched_at), the way the plays
// PK does. Runs after the play insert, so the rewatch probe is strict `<`.
export async function recordMovieWatch(env: Env, uid: number, movieId: number, watchedAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feed_posts (user_id, target_type, target_id, first_at, last_at, rewatch)
     SELECT ?1, 'movie', ?2, ?3, ?3,
            EXISTS (SELECT 1 FROM user_movie_plays q
                    WHERE q.user_id = ?1 AND q.movie_id = ?2 AND q.watched_at < ?3)
     WHERE NOT EXISTS (SELECT 1 FROM feed_posts
                       WHERE user_id = ?1 AND target_type = 'movie' AND target_id = ?2 AND first_at = ?3)`
  )
    .bind(uid, movieId, watchedAt)
    .run();
}

// After any removal of this user's plays on a show: drop post episodes whose
// exact play is gone, re-derive the posts' span, and delete posts left empty.
export async function reconcileShowPosts(env: Env, uid: number, showId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM feed_post_episodes
       WHERE post_id IN (SELECT id FROM feed_posts WHERE user_id = ?1 AND target_type = 'show' AND target_id = ?2)
         AND NOT EXISTS (SELECT 1 FROM user_episode_plays p
                         WHERE p.user_id = ?1 AND p.episode_id = feed_post_episodes.episode_id
                           AND p.watched_at = feed_post_episodes.watched_at)`
    ).bind(uid, showId),
    env.DB.prepare(
      `UPDATE feed_posts
       SET first_at = (SELECT MIN(watched_at) FROM feed_post_episodes WHERE post_id = feed_posts.id),
           last_at  = (SELECT MAX(watched_at) FROM feed_post_episodes WHERE post_id = feed_posts.id)
       WHERE user_id = ?1 AND target_type = 'show' AND target_id = ?2
         AND EXISTS (SELECT 1 FROM feed_post_episodes WHERE post_id = feed_posts.id)`
    ).bind(uid, showId),
  ]);
  const { results } = await env.DB.prepare(
    `SELECT id FROM feed_posts
     WHERE user_id = ?1 AND target_type = 'show' AND target_id = ?2
       AND NOT EXISTS (SELECT 1 FROM feed_post_episodes WHERE post_id = feed_posts.id)`
  )
    .bind(uid, showId)
    .all<{ id: number }>();
  await deletePosts(env, results.map((r) => r.id));
}

// After any removal of this user's plays on a movie: a movie post lives only
// while the play it recorded (first_at) still exists.
export async function reconcileMoviePosts(env: Env, uid: number, movieId: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM feed_posts fp
     WHERE fp.user_id = ?1 AND fp.target_type = 'movie' AND fp.target_id = ?2
       AND NOT EXISTS (SELECT 1 FROM user_movie_plays p
                       WHERE p.user_id = ?1 AND p.movie_id = ?2 AND p.watched_at = fp.first_at)`
  )
    .bind(uid, movieId)
    .all<{ id: number }>();
  await deletePosts(env, results.map((r) => r.id));
}

// Comments are polymorphic (no FK) and notifications carry post_id without
// one, so both go explicitly; episodes and reactions cascade off feed_posts.
// Comment votes/edits cascade off comments.
const DELETE_CHUNK = 50;
export async function deletePosts(env: Env, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const ph = chunk.map((_, j) => `?${j + 1}`).join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM comments WHERE target_type = 'post' AND target_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM notifications WHERE post_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM feed_posts WHERE id IN (${ph})`).bind(...chunk),
    ]);
  }
}

// May this viewer see this post? Their own, or a followee's under the feed's
// visibility rule (routes/social.ts FOLLOWING_CTE: profile public, or
// private-but-mutual). A deleted owner is gone to everyone; a shadow-banned
// owner is gone to everyone but themselves; a show the owner hid is private
// activity. Returns the owner id so callers can tell "mine" apart.
export async function canSeePost(env: Env, viewerId: number, postId: number): Promise<{ ownerId: number } | null> {
  const row = await env.DB.prepare(
    `SELECT fp.user_id AS owner_id
     FROM feed_posts fp
     JOIN users ou ON ou.id = fp.user_id AND ou.deleted_at IS NULL
     WHERE fp.id = ?2
       AND (fp.user_id = ?1
            OR (ou.shadow_banned = 0
                AND EXISTS (SELECT 1 FROM follows f
                            WHERE f.follower_id = ?1 AND f.followee_id = fp.user_id AND f.state = 'active'
                              AND (ou.profile_public = 1 OR EXISTS (
                                SELECT 1 FROM follows r
                                WHERE r.follower_id = fp.user_id AND r.followee_id = ?1 AND r.state = 'active')))))
       AND (fp.target_type = 'movie' OR NOT EXISTS (
              SELECT 1 FROM user_shows h WHERE h.user_id = fp.user_id AND h.show_id = fp.target_id AND h.hidden = 1))`
  )
    .bind(viewerId, postId)
    .first<{ owner_id: number }>();
  return row ? { ownerId: row.owner_id } : null;
}
