-- Editable comments with history. Each edit snapshots the body
-- it replaced; comments.edited_at powers the "edited" marker. Deleting a
-- comment wipes its history rows (routes/comments.ts) — deletion is a
-- privacy action and must take prior versions with it.

ALTER TABLE comments ADD COLUMN edited_at TEXT;

CREATE TABLE comment_edits (
  id         INTEGER PRIMARY KEY,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,                              -- the version this edit replaced
  edited_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_comment_edits_comment ON comment_edits(comment_id, id);
