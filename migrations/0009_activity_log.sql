-- Admin audit log: one row per mutating API request — comments,
-- votes, follows, watches, email codes, everything — written by middleware
-- in worker/index.ts, so new routes are covered automatically. For
-- troubleshooting, not for user-facing features (the social feed keeps its
-- reserved activity_events table from 0001).
--
-- user_id has NO foreign key on purpose: audit rows must survive account
-- deletion. NULL user_id = unauthenticated request (e.g. failed logins).
-- Request bodies are never stored (passwords, comment text, emails).
-- The nightly cron prunes rows older than 90 days.

CREATE TABLE activity_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id INTEGER,
  method  TEXT NOT NULL,
  route   TEXT NOT NULL,                                  -- matched pattern: /api/comments/:id/vote
  path    TEXT NOT NULL,                                  -- actual path: /api/comments/17/vote
  status  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_activity_log_ts   ON activity_log(ts);
CREATE INDEX idx_activity_log_user ON activity_log(user_id, ts);
