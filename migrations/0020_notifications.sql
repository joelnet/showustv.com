-- Notifications: in-app notification rows behind the header
-- bell, plus the per-user "someone you follow watched a show" preference.
-- The Phase-3 tables reserved in 0001 come into service alongside this:
-- push_subscriptions stores each device's Web Push endpoint as-is, and
-- notification_prefs (the user's global row, show_id = 0) gains the
-- follow_watch toggle.

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- recipient
  type        TEXT NOT NULL,                                  -- 'follow_watch' today; future kinds add themselves
  actor_id    INTEGER REFERENCES users(id) ON DELETE CASCADE, -- who triggered it (NULL for system notices)
  target_type TEXT CHECK (target_type IN ('show','movie')),
  target_id   INTEGER,                                        -- no FK: heterogeneous target (ratings pattern)
  read_at     TEXT,                                           -- NULL = unread; set when the user opens the page
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- Newest-first listing (ORDER BY id DESC within a user rides the rowid order
-- inside this index) and the dedupe lookup both start from user_id.
CREATE INDEX idx_notifications_user ON notifications(user_id);

-- The header bell polls the unread count; partial index keeps it O(unread).
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- Per-user toggle for the follow-watch notification type. Lives on the
-- global prefs row (show_id = 0 sentinel, see 0001). Default on.
ALTER TABLE notification_prefs ADD COLUMN follow_watch INTEGER NOT NULL DEFAULT 1 CHECK (follow_watch IN (0,1));
