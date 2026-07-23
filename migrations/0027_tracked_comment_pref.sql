-- Comments on tracked media notify every tracker. When ANY user
-- comments on a show or movie you track (not just people you follow — that's
-- 0022's follow_comment), you get a 'tracked_comment' notification.
--
-- No new notification columns: a tracked-comment notification reuses the
-- 0020/0021/0022 shape — target_type/target_id point at the show or movie
-- (an episode comment targets its SHOW, carrying the episode in episode_id).
--
-- Per-user toggle for the new type, on the global prefs row (show_id = 0
-- sentinel, same as follow_watch/follow_comment). Default on.
ALTER TABLE notification_prefs ADD COLUMN tracked_comment INTEGER NOT NULL DEFAULT 1 CHECK (tracked_comment IN (0,1));

-- The fan-out asks "who tracks this title?" — a media-first probe both
-- tables have never needed before (every existing index leads with
-- user_id). Without these, each comment scans the whole tracking table.
-- Both tables are WITHOUT ROWID with a (user_id, ...) PK, so the PK columns
-- ride along in every index entry: user_id needs no explicit mention.
CREATE INDEX idx_user_shows_show ON user_shows(show_id, state);
CREATE INDEX idx_user_movies_movie ON user_movies(movie_id);
