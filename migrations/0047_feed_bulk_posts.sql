-- Bulk sweeps (season / watch-all / watch-until) now post to /feed — one post
-- per sweep, see lib/feed-posts.ts recordBulkWatch. Backfill the sweeps of the
-- last 30 days (the rail's horizon) that have no post yet, so a user who only
-- ever ticks whole seasons stops being visible in the Watch Now rail but
-- missing from /feed.
--
-- A sweep is a (user, show, exact watched_at) group of more than one play:
-- single taps each get their own ms-stamped timestamp, a sweep stamps one
-- shared one. Groups already covered by a post (0046's backfill kept the
-- small ones, and live single-episode posts) are skipped via the exact-play
-- match the reconcile helper uses. Specials (season 0) are left out, like the
-- rail and the live hooks.

CREATE TABLE _sweeps AS
SELECT p.user_id, e.show_id, p.watched_at,
       MIN(EXISTS (SELECT 1 FROM user_episode_plays q
                   WHERE q.user_id = p.user_id AND q.episode_id = p.episode_id
                     AND q.watched_at < p.watched_at)) AS rewatch
FROM user_episode_plays p
JOIN episodes e ON e.id = p.episode_id
WHERE p.watched_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
  AND e.season_number > 0
  AND NOT EXISTS (SELECT 1 FROM feed_post_episodes fpe JOIN feed_posts fp ON fp.id = fpe.post_id
                  WHERE fp.user_id = p.user_id AND fpe.episode_id = p.episode_id
                    AND fpe.watched_at = p.watched_at)
GROUP BY p.user_id, e.show_id, p.watched_at
HAVING COUNT(*) > 1;

-- High-water mark: every post id above it was opened by this migration.
CREATE TABLE _mark AS SELECT COALESCE(MAX(id), 0) AS id FROM feed_posts;

INSERT INTO feed_posts (user_id, target_type, target_id, first_at, last_at, rewatch, created_at)
SELECT user_id, 'show', show_id, watched_at, watched_at, rewatch, watched_at FROM _sweeps;

-- Each new post's episodes: the plays of its sweep, tied back by
-- (user, show, stamp) among the posts above the high-water mark.
INSERT INTO feed_post_episodes (post_id, episode_id, watched_at)
SELECT fp.id, p.episode_id, p.watched_at
FROM _sweeps s
JOIN feed_posts fp ON fp.user_id = s.user_id AND fp.target_type = 'show' AND fp.target_id = s.show_id
                  AND fp.first_at = s.watched_at AND fp.id > (SELECT id FROM _mark)
JOIN user_episode_plays p ON p.user_id = s.user_id AND p.watched_at = s.watched_at
JOIN episodes e ON e.id = p.episode_id AND e.show_id = s.show_id AND e.season_number > 0;

DROP TABLE _sweeps;
DROP TABLE _mark;
