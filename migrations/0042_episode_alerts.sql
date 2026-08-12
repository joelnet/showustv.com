-- Air-date notifications: users who track a show ('watching' or 'up_to_date')
-- get an in-app notification + Web Push on the day an episode airs. TMDB has
-- no air TIMES, only dates, so delivery happens at a per-user time of day —
-- global per user, not per show — defaulting to 8:00 AM in the user's tz.
--
-- notify_min is minutes past LOCAL midnight (480 = 8:00 AM), applied in
-- users.tz at delivery time. Stored as wall-clock minutes rather than a UTC
-- instant because it recurs daily and must survive DST shifts.
ALTER TABLE users ADD COLUMN notify_min INTEGER NOT NULL DEFAULT 480 CHECK (notify_min BETWEEN 0 AND 1439);

-- The alert ledger the */5 cron drives. One row per (recipient, show, air
-- date) — the PK IS the dedupe, so a multi-episode drop day ("8 episodes of
-- X out today") is one row with ep_count = 8, and every generation re-run is
-- an INSERT OR IGNORE no-op. Rows double as the push queue: pushed_at NULL
-- means a push is still owed; the delivery loop claims batches atomically
-- (UPDATE ... RETURNING) and backlog carries over between runs, so fan-out
-- has no upper limit — a popular show's thousands of pushes just drain
-- across a few runs.
--
-- episode_id is the representative episode (lowest season/number that day),
-- deliberately WITHOUT a foreign key: ensureShow hard-deletes episodes on
-- every resync, so a plain FK would fail the nightly sync and a CASCADE
-- would erase the dedupe row and re-alert. Same choice as
-- notifications.episode_id (0021); readers LEFT-join and degrade to
-- show-only copy when the episode is gone.
CREATE TABLE episode_alerts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id    INTEGER NOT NULL REFERENCES shows(tmdb_id) ON DELETE CASCADE,
  air_date   TEXT NOT NULL,               -- date-only 'YYYY-MM-DD' (the episode's air date)
  episode_id INTEGER NOT NULL,            -- representative episode; no FK on purpose
  ep_count   INTEGER NOT NULL DEFAULT 1,  -- episodes of this show airing that day at generation time
  created_at TEXT NOT NULL,               -- generation-run stamp (UTC ISO), shared by the run's batch
  pushed_at  TEXT,                        -- NULL = push pending; stamped at claim time (at-most-once)
  PRIMARY KEY (user_id, show_id, air_date)
) STRICT, WITHOUT ROWID;

-- Drives the delivery claim (oldest pending first) and the same-batch
-- notifications INSERT; partial so it stays O(backlog), which is ~0 outside
-- delivery waves. Partial-index precedent: 0020's unread index.
CREATE INDEX idx_episode_alerts_pending ON episode_alerts(created_at) WHERE pushed_at IS NULL;
