-- Recent activity on the public profile (issue #202): the 20 most recent
-- things the user did — followed a show, saved one for later, watched an
-- episode or movie, rated something. Derived at read time from user_shows /
-- user_episodes / user_movies / ratings, so there's no new write path and
-- history predating this migration appears immediately.
--
-- Visible by default (the profile itself is already gated by profile_public
-- and the mutual-follow rule); the owner hides it with the eye toggle beside
-- the Activity heading on their own public profile page.
--
-- Update (issue #249): the profile Activity section and its eye toggle were
-- removed. The column stays — the followee activity feed (issue #205:
-- /social/activity, /social/also-watching, the library home rail, and
-- friends-watching notifications) still gates on activity_public = 1.

ALTER TABLE users ADD COLUMN activity_public INTEGER NOT NULL DEFAULT 1 CHECK (activity_public IN (0,1));
