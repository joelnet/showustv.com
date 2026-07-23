-- Allow 'list' as a notification target_type so a "created a new
-- list" notification can point at the list (target_id = custom_lists.id),
-- resolved to the list name + owner username at read time like every other
-- notification target. SQLite can't ALTER a CHECK, so the table is recreated
-- (same pattern as 0018 widening comments.target_type).
--
-- Unlike the comments rebuild in 0018, nothing has a foreign key TO
-- notifications (it only references users, an outgoing FK), so the DROP cascades
-- into no child tables and no backup dance is needed — just copy the rows, swap,
-- and recreate both indexes. id is copied verbatim so the notifications page's
-- keyset pagination (ORDER BY id) is unaffected.

CREATE TABLE notifications_new (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- recipient
  type        TEXT NOT NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,           -- who triggered it (NULL for system notices)
  target_type TEXT CHECK (target_type IN ('show','movie','list')),
  target_id   INTEGER,                                                  -- no FK: heterogeneous target
  read_at     TEXT,                                                     -- NULL = unread
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  episode_id  INTEGER                                                   -- added in 0021; NULL except episode rows
) STRICT;

INSERT INTO notifications_new (id, user_id, type, actor_id, target_type, target_id, read_at, created_at, episode_id)
  SELECT id, user_id, type, actor_id, target_type, target_id, read_at, created_at, episode_id FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

-- Recreate both indexes from 0020 (newest-first listing / dedupe start, and the
-- partial index the bell's unread count rides).
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
