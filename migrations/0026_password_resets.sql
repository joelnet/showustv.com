-- Forgot-password flow. Mirrors email_verifications (0007):
-- one pending reset per user — a new request replaces the row — and only the
-- token's SHA-256 digest is stored (the raw token exists only in the emailed
-- link), so a DB leak can't reset anyone's password. Single-use: the worker
-- deletes the row on first presentation, valid or expired; a short TTL
-- (expires_at, 30 minutes) bounds the window either way.

CREATE TABLE password_resets (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
) STRICT;
