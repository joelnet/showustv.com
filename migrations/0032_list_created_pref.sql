-- issue #331: per-user toggle for the "someone you follow created a public
-- list" notification. Lives on the global prefs row (show_id = 0 sentinel, see
-- 0001), like every other notification type. Default on, matching the fan-out's
-- COALESCE(..., 1) so a user with no prefs row still hears about it.
ALTER TABLE notification_prefs ADD COLUMN list_created INTEGER NOT NULL DEFAULT 1 CHECK (list_created IN (0,1));
