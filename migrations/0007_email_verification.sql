-- Email verification. users.email (0001) stays the verified
-- address; the pending address lives here until its token is clicked, so an
-- unconfirmed typo can never clobber a verified email. One pending
-- verification per user — resending replaces the row.

ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE TABLE email_verifications (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
) STRICT;
