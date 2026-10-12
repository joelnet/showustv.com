-- Instagram-style social feed (/feed, beta-gated in code for now).
--
-- 1) feed_posts: one user's watches of ONE show (one or more episodes — a new
--    single-episode watch joins the watcher's latest post for that show while
--    it lands within 8h of the post's last_at, see lib/feed-posts.ts) or ONE
--    movie play. Materialized rather than derived from the plays tables so a
--    post has a stable id for reactions, comments, and notification links.
--    Only the single-episode watch and movie watch routes create posts; the
--    bulk season/show sweeps and the importer are history backfill and never
--    post (the same rule the follow-watch notification uses).
CREATE TABLE feed_posts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('show','movie')),
  target_id   INTEGER NOT NULL,          -- tmdb id, no FK (the ratings pattern)
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  rewatch     INTEGER NOT NULL DEFAULT 0 CHECK (rewatch IN (0,1)), -- every play in the post was a rewatch
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
-- Feed keyset (last_at DESC, id DESC) and the "latest post for this show"
-- probe the watch hook runs.
CREATE INDEX idx_feed_posts_last        ON feed_posts(last_at, id);
CREATE INDEX idx_feed_posts_user_target ON feed_posts(user_id, target_type, target_id, last_at);

-- The episodes inside a show post. watched_at is the EXACT play the row
-- records: an episode stays in its post only while that play still exists
-- in user_episode_plays, which is what makes un-ticks, play removals, and
-- full unwatches all reconcile the same way.
CREATE TABLE feed_post_episodes (
  post_id    INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL,
  PRIMARY KEY (post_id, episode_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_feed_post_episodes_episode ON feed_post_episodes(episode_id);

-- One emoji per viewer per post (picking another replaces it, picking the
-- same one clears it). The emoji is validated in the worker against the
-- curated list in shared/post-reactions.ts. Separate from activity_reactions,
-- which serves the "From People You Follow" rail and is keyed per episode.
CREATE TABLE post_reactions (
  post_id    INTEGER NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (post_id, user_id)
) STRICT, WITHOUT ROWID;

-- 2) Add 'post' to the comments.target_type CHECK so posts reuse the threaded
-- comment system. SQLite can't ALTER a CHECK, so the table is recreated —
-- the exact 0018 dance: D1 fires ON DELETE CASCADE on the DROP, which would
-- wipe comment_votes and comment_edits, so those are copied out and restored
-- around the swap. comments_new self-references itself (not the old table) so
-- the DROP can't cascade into the copy; RENAME rewrites the self-ref.
CREATE TABLE _comment_votes_bak AS SELECT * FROM comment_votes;
CREATE TABLE _comment_edits_bak AS SELECT * FROM comment_edits;

CREATE TABLE comments_new (
  id          INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('episode','movie','show','list','post')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'en',
  parent_id   INTEGER REFERENCES comments_new(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT,
  edited_at   TEXT
) STRICT;

INSERT INTO comments_new (id, target_type, target_id, user_id, body, lang, parent_id, created_at, deleted_at, edited_at)
  SELECT id, target_type, target_id, user_id, body, lang, parent_id, created_at, deleted_at, edited_at FROM comments;

DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

INSERT INTO comment_votes SELECT * FROM _comment_votes_bak;
INSERT INTO comment_edits SELECT * FROM _comment_edits_bak;
DROP TABLE _comment_votes_bak;
DROP TABLE _comment_edits_bak;

CREATE INDEX idx_comments_target ON comments(target_type, target_id, created_at);
CREATE INDEX idx_comments_user   ON comments(user_id, created_at);
-- 0018 forgot this one and 0019 had to restore it — recreate it here.
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- 3) Notification deep links for the post_comment / post_reply /
-- post_reaction types (the 0021 nullable-ALTER pattern, no rebuild).
-- target_type stays NULL on those rows; the read model joins feed_posts live.
-- comment_id is the comment that triggered the row. No FKs: lib/feed-posts.ts
-- deletePosts() removes a post's notifications explicitly.
ALTER TABLE notifications ADD COLUMN post_id INTEGER;
ALTER TABLE notifications ADD COLUMN comment_id INTEGER;

-- 4) Backfill the last 30 days (the rail's horizon) so the feed isn't empty
-- on day one. Plain SQL can't do the 8h-gap grouping cheaply, so a post is
-- one (user, show, UTC day) group — a binge across midnight splits in two,
-- accepted for a one-shot backfill. Specials (season 0) are left out like the
-- rail does. Bulk sweeps and imports stamp ONE shared timestamp on every row
-- they write; the live hooks never post those, so the backfill skips a group
-- whose plays all share a timestamp unless it's small enough to be a hand
-- binge (three or fewer).
INSERT INTO feed_posts (user_id, target_type, target_id, first_at, last_at, created_at)
SELECT p.user_id, 'show', e.show_id, MIN(p.watched_at), MAX(p.watched_at), MAX(p.watched_at)
FROM user_episode_plays p
JOIN episodes e ON e.id = p.episode_id
WHERE p.watched_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
  AND e.season_number > 0
GROUP BY p.user_id, e.show_id, substr(p.watched_at, 1, 10)
HAVING COUNT(DISTINCT p.watched_at) > 1 OR COUNT(*) <= 3;

-- Each post's episodes: the plays of that user/show on the post's UTC day.
-- A same-day replay of one episode collapses to its latest play.
INSERT INTO feed_post_episodes (post_id, episode_id, watched_at)
SELECT fp.id, p.episode_id, MAX(p.watched_at)
FROM feed_posts fp
JOIN user_episode_plays p ON p.user_id = fp.user_id
JOIN episodes e ON e.id = p.episode_id AND e.show_id = fp.target_id AND e.season_number > 0
WHERE fp.target_type = 'show'
  AND substr(p.watched_at, 1, 10) = substr(fp.last_at, 1, 10)
GROUP BY fp.id, p.episode_id;

-- Movies: one post per dated play, flagged as a rewatch when an earlier play exists.
INSERT INTO feed_posts (user_id, target_type, target_id, first_at, last_at, rewatch, created_at)
SELECT p.user_id, 'movie', p.movie_id, p.watched_at, p.watched_at,
       EXISTS (SELECT 1 FROM user_movie_plays q
               WHERE q.user_id = p.user_id AND q.movie_id = p.movie_id AND q.watched_at < p.watched_at),
       p.watched_at
FROM user_movie_plays p
WHERE p.watched_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days');

-- A show post is a rewatch when every episode in it had an earlier play.
UPDATE feed_posts SET rewatch = 1
WHERE target_type = 'show'
  AND NOT EXISTS (
    SELECT 1 FROM feed_post_episodes fpe
    WHERE fpe.post_id = feed_posts.id
      AND NOT EXISTS (SELECT 1 FROM user_episode_plays q
                      WHERE q.user_id = feed_posts.user_id AND q.episode_id = fpe.episode_id
                        AND q.watched_at < fpe.watched_at));
