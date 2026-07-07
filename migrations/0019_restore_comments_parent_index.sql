-- Restore idx_comments_parent, dropped when 0018 recreated the comments table.
-- 0018 rebuilt only idx_comments_target and idx_comments_user (from 0001) and
-- missed the parent_id index added in 0005 (reply-parent lookups + delete-cascade
-- walks). IF NOT EXISTS makes this safe if the index is somehow already present.

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
