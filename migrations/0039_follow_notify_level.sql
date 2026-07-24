-- Per-follow notification level (#18), YouTube-style: each follow edge now
-- carries how loudly its FOLLOWER wants to hear about this one followee's
-- activity (watches, favorites, comments on titles the follower tracks, new
-- lists — the fan-outs in lib/notifications.ts that key on the follow edge):
--   all  — every event lands, no 24h dedupe (a ten-episode binge is ten
--          notifications, exactly as asked)
--   some — the previous behavior: 24h dedupe per (actor, target) plus the
--          existing fan-out caps
--   none — the follow itself keeps working (feed, also-watching, mutuals)
--          but this followee's activity never notifies
-- Only the follower can set it (the /social/follow/:username/notify route
-- updates WHERE follower_id = caller), and a fresh follow starts at 'some' —
-- the default below also pins every EXISTING follow to exactly its old
-- behavior. The followee-side "X followed you" notification and the
-- tracking-based tracked_comment fan-out key on other relationships and
-- ignore this column; the recipient's global notification_prefs toggles
-- still gate on top.
ALTER TABLE follows ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'some'
  CHECK (notify_level IN ('all','some','none'));
