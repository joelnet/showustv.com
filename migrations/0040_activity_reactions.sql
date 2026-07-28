-- Reactions on "From People You Follow" activity (#20): a follower taps the
-- thumbs-up on a feed tile and picks from the Facebook-familiar set. One
-- reaction per (reactor, activity), where an activity is keyed the way the
-- rail keys its tiles — the watcher plus the show/movie watched — so the
-- reaction stays put when the followee watches further episodes and the tile
-- advances. Changing a reaction is an in-place UPDATE and clearing it is a
-- DELETE (the comment_votes pattern, 0005). Distinct from
-- ratings.emoji_reaction, which is the TV Time-style emotion a user pins on
-- their OWN rating; these are social — aimed at someone else's activity.

CREATE TABLE activity_reactions (
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- whose activity was reacted to
  target_type TEXT NOT NULL CHECK (target_type IN ('show','movie')),
  target_id   INTEGER NOT NULL,                                        -- tmdb id; no FK: heterogeneous target (ratings pattern)
  reactor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- who reacted
  reaction    TEXT NOT NULL CHECK (reaction IN ('like','love','laugh','wow','sad')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, target_type, target_id, reactor_id)
) STRICT, WITHOUT ROWID;

-- Reactor-side scans (account-deletion cascade); the owner-first PK covers
-- the rail's per-activity counts and the owner-side cascade.
CREATE INDEX idx_activity_reactions_reactor ON activity_reactions(reactor_id);

-- Per-user toggle for the "someone reacted to your activity" notification
-- type, on the global prefs row (show_id = 0 sentinel) like every other
-- notification pref. Default on.
ALTER TABLE notification_prefs ADD COLUMN reaction INTEGER NOT NULL DEFAULT 1 CHECK (reaction IN (0,1));
