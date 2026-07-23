-- Friend graph: mutual friendships with an accept step.
-- One row per pair, stored directionally as requester → addressee so
-- "who asked whom" survives; status flips to 'accepted' in place.
-- (The Phase-2 `follows` table from 0001 stays reserved for a future
-- asymmetric follow feature — friendships are a separate, mutual edge.)

CREATE TABLE friendships (
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  accepted_at  TEXT,                                       -- set when status flips to 'accepted'
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
) STRICT, WITHOUT ROWID;

-- A pair may have at most ONE edge in either direction: A→B and B→A can
-- never coexist (the API auto-accepts a request-back instead). Enforced at
-- the schema level via the unordered pair.
CREATE UNIQUE INDEX idx_friendships_pair
  ON friendships (MIN(requester_id, addressee_id), MAX(requester_id, addressee_id));

-- Incoming-request / reverse-edge lookups (the PK covers the forward edge).
CREATE INDEX idx_friendships_addressee ON friendships (addressee_id, status);

-- Friends-activity feed scans (routes/social.ts): per-friend time-window
-- lookups over the library tables. user_episodes is already covered by
-- idx_user_episodes_user_watched (0001); these cover the other branches.
CREATE INDEX idx_user_shows_user_added    ON user_shows (user_id, added_at);
CREATE INDEX idx_user_movies_user_watched ON user_movies (user_id, state, watched_at);
CREATE INDEX idx_ratings_user_created     ON ratings (user_id, created_at);
