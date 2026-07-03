-- Achievements (issue #19). The catalog (ids, titles, unlock rules) lives in
-- code — src/shared/achievements.ts — so it ships with deploys and the web
-- renders it without a fetch; only unlocks are rows. Awards are computed
-- from existing data by src/worker/lib/achievements.ts after each mutation,
-- so nothing here stores progress. (The Phase-3 badges tables from 0001 stay
-- reserved for TV Time-style tiered badges.)

CREATE TABLE user_achievements (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,                          -- slug from the code catalog
  unlocked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, achievement_id)
) STRICT, WITHOUT ROWID;
