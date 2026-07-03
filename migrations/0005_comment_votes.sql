-- Reddit-style comment votes: one up/down vote per user per comment.
-- Replaces the unused Phase-2 comment_likes table from 0001 — a comment's
-- score is SUM(value) over this table, so flipping a vote is an in-place
-- UPDATE and un-voting is a DELETE.

DROP TABLE comment_likes;

CREATE TABLE comment_votes (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (comment_id, user_id)
) STRICT, WITHOUT ROWID;

-- User-side scans (account-deletion cascade); the PK covers per-comment sums.
CREATE INDEX idx_comment_votes_user ON comment_votes(user_id);

-- Reply-parent lookups and delete-cascade walks; 0001 only indexed by target.
CREATE INDEX idx_comments_parent ON comments(parent_id);
