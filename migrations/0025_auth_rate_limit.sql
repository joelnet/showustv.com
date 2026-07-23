-- Auth rate limiting: one row per counted auth event —
-- a failed login or a register attempt — keyed by a composite bucket string
-- ("login:ip:<addr>", "login:id:<identifier>", "register:ip:<addr>",
-- "register:email:<email>"). The worker counts rows newer than the window to
-- decide 429s: the same sliding-window idea as the comment rate limit, which
-- counts the comments table itself; auth events leave no natural row behind,
-- hence this table. No foreign keys on purpose — rows describe requests, not
-- accounts. Old rows are pruned opportunistically on the write path (see
-- src/worker/lib/rate-limit.ts), so no cron dependency.

CREATE TABLE auth_attempts (
  id         INTEGER PRIMARY KEY,
  rl_key     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_auth_attempts_key_time ON auth_attempts(rl_key, created_at);
