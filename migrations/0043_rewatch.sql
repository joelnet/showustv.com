-- Rewatch rounds + per-play dated history. A "round" is one explicit rewatch
-- run of a show (Simkl's session model): round 2 is the first rewatch — the
-- original watch is implicitly round 1 — with its own start date, its own
-- progress (episodes played on/after started_at), and auto-completion when
-- every aired regular-season episode has a this-round play. Plays are the
-- append-only dated history underneath (Trakt's model): every watch action
-- records one, and nothing — starting, finishing, or canceling a round —
-- ever deletes them. user_episodes / user_movies keep their existing roles
-- (watched flag + denormalized play_count); every endpoint that bumps
-- play_count now ALSO inserts a play row, so counts and dated history stay
-- in step going forward.

-- One row per rewatch run of a show. round 2 = first rewatch (the first
-- watch is implicitly round 1). At most one active (finished_at IS NULL)
-- round per show.
-- prev_state is the user_shows.state the round displaced when it opened
-- (NULL when the show had no user_shows row at all). Starting a round forces
-- the show to 'watching' — that flip is what puts it back in Library Watching
-- and Watch Next — and without a memo of what was there before, an abandoned
-- show rewatched once could never return to the Abandoned tab and an
-- unfollowed-hidden show would silently rejoin the library forever. Cancel
-- and auto-complete hand it back.
CREATE TABLE user_show_rewatches (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id     INTEGER NOT NULL REFERENCES shows(tmdb_id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  prev_state  TEXT,
  PRIMARY KEY (user_id, show_id, round)
) STRICT, WITHOUT ROWID;

-- Append-only dated plays. PK dedupes identical-timestamp replays, which is
-- exactly the offline-queue retry guard the old play_count WHERE clause
-- implemented (the queue stamps watched_at at enqueue time).
CREATE TABLE user_episode_plays (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, episode_id, watched_at)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_user_episode_plays_user_watched ON user_episode_plays(user_id, watched_at);

CREATE TABLE user_movie_plays (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id   INTEGER NOT NULL REFERENCES movies(tmdb_id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, movie_id, watched_at)
) STRICT, WITHOUT ROWID;
-- The twin of the episode index above, for the same reader: /home's History
-- rail walks both tables newest-first per user.
CREATE INDEX idx_user_movie_plays_user_watched ON user_movie_plays(user_id, watched_at);

-- Backfill from the legacy columns (first watch + last rewatch are the only
-- dates the old schema kept). Legacy rows may still have play_count > dated
-- plays — the middle plays were never dated — which the UI reports honestly
-- as "+ N earlier plays (undated)".
INSERT OR IGNORE INTO user_episode_plays (user_id, episode_id, watched_at)
  SELECT user_id, episode_id, watched_at FROM user_episodes;
INSERT OR IGNORE INTO user_episode_plays (user_id, episode_id, watched_at)
  SELECT user_id, episode_id, last_rewatched_at FROM user_episodes
  WHERE last_rewatched_at IS NOT NULL AND last_rewatched_at != watched_at;
INSERT OR IGNORE INTO user_movie_plays (user_id, movie_id, watched_at)
  SELECT user_id, movie_id, watched_at FROM user_movies
  WHERE state = 'watched' AND watched_at IS NOT NULL;
