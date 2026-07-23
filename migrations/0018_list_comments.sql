-- List comments: a per-list on/off toggle plus allowing 'list' as a
-- comment target so lists can reuse the existing threaded-comment system.

-- 1) Per-list toggle, controlled by the list owner. Off by default (opt-in).
ALTER TABLE custom_lists ADD COLUMN comments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (comments_enabled IN (0,1));

-- 2) Add 'list' to the comments.target_type CHECK. SQLite can't ALTER a CHECK,
-- so the table is recreated. D1 fires ON DELETE CASCADE on the DROP, which would
-- otherwise wipe the comment child rows (comment_votes and comment_edits — the
-- old comment_likes table was dropped in 0005), so those rows are copied out and
-- restored around the swap (verified locally). The new table self-references
-- comments_new (not the old comments) so the DROP doesn't cascade into the copy;
-- RENAME then rewrites the self-ref to point at "comments".
CREATE TABLE _comment_votes_bak AS SELECT * FROM comment_votes;
CREATE TABLE _comment_edits_bak AS SELECT * FROM comment_edits;

CREATE TABLE comments_new (
  id          INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('episode','movie','show','list')),
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
