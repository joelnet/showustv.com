-- 0001_init.sql — full schema baseline for the TV Time clone (D1 / SQLite).
-- Conventions:
--   * All *_at / *_utc columns are ISO 8601 UTC TEXT: '2026-07-02T06:00:00.000Z'.
--     Default via strftime('%Y-%m-%dT%H:%M:%fZ','now').
--   * STRICT tables; WITHOUT ROWID for composite-PK junction tables.
--   * D1 enforces foreign keys by default.
--   * Catalog rows are keyed on TMDB ids; tvdb_id kept for TV Time import matching.
--   * Sessions are stateless signed cookies — no table.
--   * air_date is date-only 'YYYY-MM-DD' (TMDB provides no air times).

-- ============ Identity ============

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  email           TEXT UNIQUE COLLATE NOCASE,             -- optional; future password reset
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash         TEXT NOT NULL,                          -- 'pbkdf2:<iters>:<salt_b64>:<hash_b64>'
  display_name    TEXT,
  tz              TEXT NOT NULL DEFAULT 'UTC',            -- IANA name, never a raw offset
  is_private      INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0,1)),
  preferred_langs TEXT NOT NULL DEFAULT 'en',             -- comma-separated ISO 639-1
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      TEXT                                     -- soft delete; hard wipe after grace period
) STRICT;

-- ============ Catalog (mirrored from TMDB) ============

CREATE TABLE shows (
  tmdb_id         INTEGER PRIMARY KEY,
  tvdb_id         INTEGER,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown',        -- TMDB status string: 'Returning Series', 'Ended', ...
  first_air_date  TEXT,                                   -- date only: 'YYYY-MM-DD'
  poster_url      TEXT,                                   -- path fragment; prepend TMDB_IMG_BASE client-side
  backdrop_url    TEXT,
  overview        TEXT,
  genres_json     TEXT NOT NULL DEFAULT '[]',
  network_tz      TEXT,                                   -- IANA name of originating network, if known
  synced_at       TEXT                                    -- last nightly-sync touch
) STRICT;

CREATE INDEX idx_shows_tvdb ON shows(tvdb_id);            -- TV Time CSV import matching

CREATE TABLE seasons (
  id       INTEGER PRIMARY KEY,                           -- TMDB season id
  show_id  INTEGER NOT NULL REFERENCES shows(tmdb_id) ON DELETE CASCADE,
  number   INTEGER NOT NULL,                              -- 0 = specials
  name     TEXT,
  UNIQUE (show_id, number)
) STRICT;

CREATE TABLE episodes (
  id            INTEGER PRIMARY KEY,                      -- TMDB episode id
  season_id     INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  show_id       INTEGER NOT NULL REFERENCES shows(tmdb_id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,                         -- denormalized from seasons: keeps Up Next/progress single-table
  number        INTEGER NOT NULL,
  title         TEXT,
  air_date      TEXT,                                     -- date-only 'YYYY-MM-DD'; NULL if unscheduled
  runtime_min   INTEGER,
  overview      TEXT,
  still_url     TEXT,
  tvdb_id       INTEGER
) STRICT;

CREATE INDEX idx_episodes_show_order ON episodes(show_id, season_number, number);
CREATE INDEX idx_episodes_show_air   ON episodes(show_id, air_date);
CREATE INDEX idx_episodes_air        ON episodes(air_date);     -- calendar + cron scans
CREATE INDEX idx_episodes_tvdb       ON episodes(tvdb_id);      -- import matching

CREATE TABLE movies (
  tmdb_id      INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  release_date TEXT,                                      -- date only: 'YYYY-MM-DD'
  runtime_min  INTEGER,
  poster_url   TEXT,
  overview     TEXT,
  genres_json  TEXT NOT NULL DEFAULT '[]',
  synced_at    TEXT
) STRICT;

-- ============ User library state ============

CREATE TABLE user_shows (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id           INTEGER NOT NULL REFERENCES shows(tmdb_id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'watching'
                      CHECK (state IN ('watching','up_to_date','finished','stopped','watch_later','hidden')),
  favorited         INTEGER NOT NULL DEFAULT 0 CHECK (favorited IN (0,1)),
  added_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_state_change TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, show_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_shows_user_state ON user_shows(user_id, state);

CREATE TABLE user_episodes (
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id        INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  watched_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  play_count        INTEGER NOT NULL DEFAULT 1,
  last_rewatched_at TEXT,
  PRIMARY KEY (user_id, episode_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_episodes_user_watched ON user_episodes(user_id, watched_at);

CREATE TABLE user_movies (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id   INTEGER NOT NULL REFERENCES movies(tmdb_id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'watchlist' CHECK (state IN ('watchlist','watched')),
  watched_at TEXT,
  play_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, movie_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_user_movies_user_state ON user_movies(user_id, state);

-- ============ Ratings / reactions ============

-- Emotion reaction is folded into ratings.emoji_reaction (one row per user+target).
CREATE TABLE ratings (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL CHECK (target_type IN ('episode','movie','show')),
  target_id      INTEGER NOT NULL,                        -- no FK: heterogeneous target
  score          INTEGER CHECK (score BETWEEN 1 AND 10),
  emoji_reaction TEXT,                                    -- one of the fixed emotion set (packages/shared/constants.ts)
  review_text    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, target_type, target_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_ratings_target ON ratings(target_type, target_id);

CREATE TABLE episode_character_votes (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id   INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,                             -- TMDB credit_id (string)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, episode_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_char_votes_episode ON episode_character_votes(episode_id, character_id);

-- ============ Custom lists ============

CREATE TABLE custom_lists (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_shared  INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_custom_lists_user ON custom_lists(user_id);

CREATE TABLE custom_list_items (
  list_id     INTEGER NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('show','movie')),
  target_id   INTEGER NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, target_type, target_id)
) STRICT, WITHOUT ROWID;

-- ============ Social (Phase 2) ============

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','pending')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_follows_followee ON follows(followee_id, state);

CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('episode','movie','show')),
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'en',                 -- detected at write time; powers language filter
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT                                        -- soft delete keeps threads intact
) STRICT;

CREATE INDEX idx_comments_target ON comments(target_type, target_id, created_at);
CREATE INDEX idx_comments_user   ON comments(user_id, created_at);

CREATE TABLE comment_likes (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (comment_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE activity_events (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_type  TEXT NOT NULL,                              -- 'watched_episode' | 'added_show' | 'rated' | 'commented' | 'followed' | ...
  target_type TEXT,
  target_id   INTEGER,
  meta        TEXT NOT NULL DEFAULT '{}'                  -- JSON
) STRICT;

CREATE INDEX idx_activity_user_ts ON activity_events(user_id, ts DESC);

-- ============ Notifications (Phase 3) ============

CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_push_user ON push_subscriptions(user_id);

-- show_id 0 = the user's global default row (SQLite can't use COALESCE in a PK).
-- No FK on show_id because of the 0 sentinel.
CREATE TABLE notification_prefs (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id             INTEGER NOT NULL DEFAULT 0,
  push_new_episode    INTEGER NOT NULL DEFAULT 1 CHECK (push_new_episode IN (0,1)),
  email_weekly_digest INTEGER NOT NULL DEFAULT 0 CHECK (email_weekly_digest IN (0,1)),
  PRIMARY KEY (user_id, show_id)
) STRICT, WITHOUT ROWID;

-- ============ Badges (Phase 3) ============

CREATE TABLE badges (
  id          INTEGER PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN ('discovery','addiction')),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  tier        INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE user_badges (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  unlocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  level       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, badge_id)
) STRICT, WITHOUT ROWID;

-- series_id 0 = badge progress not scoped to a show (same sentinel pattern as notification_prefs).
CREATE TABLE badge_progress (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id            INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  series_id           INTEGER NOT NULL DEFAULT 0,
  counter             INTEGER NOT NULL DEFAULT 0,
  last_incremented_at TEXT,
  PRIMARY KEY (user_id, badge_id, series_id)
) STRICT, WITHOUT ROWID;
