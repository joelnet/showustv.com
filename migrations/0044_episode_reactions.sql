-- Make the "From People You Follow" thumbs-up belong to the EPISODE, not the
-- show (#24). 0040 keyed a reaction the way the rail keys its tiles — the
-- watcher plus the show/movie watched — so the reaction would "stay put when
-- the followee watches further episodes and the tile advances". In practice
-- that reads as a bug: react to someone's S01E01, and when they watch S01E02
-- the tile comes back already reacted, with no way to react to the new
-- episode. The activity being reacted to is the WATCH, and a watch is an
-- episode.
--
-- episode_id joins the primary key, so it can't be NULL (a WITHOUT ROWID
-- table's PK columns are implicitly NOT NULL) and it can't be bolted on with
-- ALTER TABLE either — the table is recreated, the 0033 pattern. Nothing has a
-- foreign key TO activity_reactions, so the DROP cascades into no child tables.
-- Movie reactions carry 0, the "no episode" sentinel notification_prefs already
-- uses for its global row (show_id = 0); a movie is watched once, so its
-- reaction stays exactly as show-level ones were.
--
-- Deploy window, eyes open (the 0014/0033 trade): CI applies migrations before
-- uploading the Worker, so for the length of one `wrangler deploy` the live old
-- code is talking to the new table. Its DELETE and COUNT still work; its upsert
-- names the old four-column conflict target and fails, so a thumbs-up in that
-- window is a 500 the client's optimistic flip unwinds. Nothing is written
-- wrong and nothing is lost — the failure is loud and transient — which is why
-- this rebuilds in place rather than dragging a v2 table and a second release
-- through the tree the way a table with real write volume would deserve.

CREATE TABLE activity_reactions_new (
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- whose activity was reacted to
  target_type TEXT NOT NULL CHECK (target_type IN ('show','movie')),
  target_id   INTEGER NOT NULL,                                        -- tmdb id; no FK: heterogeneous target (ratings pattern)
  episode_id  INTEGER NOT NULL,                                        -- episodes.id for shows, 0 for movies; no FK, matching target_id
  reactor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- who reacted
  reaction    TEXT NOT NULL CHECK (reaction IN ('like','love','laugh','wow','sad')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, target_type, target_id, episode_id, reactor_id)
) STRICT, WITHOUT ROWID;

-- Existing reactions are re-pointed rather than dropped. Which episode an old
-- show-level reaction meant was never recorded, so this INFERS it: the latest
-- episode the owner had watched as of the reaction's timestamp, which is the
-- tile the reactor was almost certainly looking at. It can be off by one — the
-- rail is served stale-while-revalidate, so a reactor may have tapped a tile
-- the owner had already moved past — and a wrong guess lands the reaction (and
-- the notification backfilled from it below) on a neighbouring episode. That
-- is the lossy part, and it is the better failure: parking every legacy row on
-- the 0 sentinel instead would keep the rows but drop them out of every tile's
-- reach, which reads to users as the counts and their own reactions simply
-- vanishing. Same recency expression the rail uses (a rewatch bumps the tile),
-- same season_number > 0 filter (a special can never be the tile). Falling back to
-- the owner's earliest watch of the show covers clock skew between the watch
-- and the reaction; 0 covers an owner who has since unwatched the show
-- entirely, which parks the row harmlessly out of every tile's reach instead
-- of deleting it. The old key guarantees one row per (owner, target, reactor),
-- so widening it can't collide — a plain INSERT would fail loudly if it did.
INSERT INTO activity_reactions_new (owner_id, target_type, target_id, episode_id, reactor_id, reaction, created_at)
  SELECT ar.owner_id, ar.target_type, ar.target_id,
         CASE WHEN ar.target_type = 'movie' THEN 0 ELSE COALESCE(
           (SELECT e.id
              FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
             WHERE ue.user_id = ar.owner_id AND e.show_id = ar.target_id AND e.season_number > 0
               AND (CASE WHEN ue.last_rewatched_at > ue.watched_at
                         THEN ue.last_rewatched_at ELSE ue.watched_at END) <= ar.created_at
             ORDER BY (CASE WHEN ue.last_rewatched_at > ue.watched_at
                            THEN ue.last_rewatched_at ELSE ue.watched_at END) DESC,
                      e.season_number DESC, e.number DESC
             LIMIT 1),
           (SELECT e.id
              FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
             WHERE ue.user_id = ar.owner_id AND e.show_id = ar.target_id AND e.season_number > 0
             ORDER BY (CASE WHEN ue.last_rewatched_at > ue.watched_at
                            THEN ue.last_rewatched_at ELSE ue.watched_at END) ASC,
                      e.season_number ASC, e.number ASC
             LIMIT 1),
           0) END,
         ar.reactor_id, ar.reaction, ar.created_at
    FROM activity_reactions ar;

DROP TABLE activity_reactions;
ALTER TABLE activity_reactions_new RENAME TO activity_reactions;

-- Recreate 0040's reactor-side index (account-deletion cascade); the
-- owner-first PK still covers the rail's per-activity counts.
CREATE INDEX idx_activity_reactions_reactor ON activity_reactions(reactor_id);

-- Reaction notifications now record the episode too, so the row can name it
-- and the 24h dedupe is per episode (reacting to a second episode of the same
-- show is a second event, not a repeat). Backfill the show rows written before
-- this migration from the reaction they point at, so the notifications page
-- keeps resolving their emoji through its full-key join instead of degrading
-- them all to a bare "reacted". Rows whose reaction was since cleared have
-- nothing to point at and stay NULL — which is exactly how a cleared reaction
-- already renders. The re-key above preserves one reaction row per
-- (owner, target, reactor), so the correlated subquery stays single-valued.
UPDATE notifications
   SET episode_id = (SELECT ar.episode_id FROM activity_reactions ar
                      WHERE ar.owner_id = notifications.user_id
                        AND ar.reactor_id = notifications.actor_id
                        AND ar.target_type = notifications.target_type
                        AND ar.target_id = notifications.target_id)
 WHERE type = 'reaction' AND target_type = 'show' AND episode_id IS NULL;
