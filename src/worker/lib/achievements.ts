// Achievement awarding (issue #19). checkAchievements() recomputes a user's
// earned set from live data and INSERT OR IGNOREs anything new — no stored
// progress counters to drift. It runs in the background (waitUntil) after
// every successful mutation, hooked from worker/index.ts, so unlocks are
// eventually-consistent within a request or two and no route needs to know
// achievements exist. Cost: one D1 batch of aggregate reads, all indexed by
// user id and bounded by the user's own data.

import type { Env } from "../env";

export async function checkAchievements(env: Env, uid: number): Promise<void> {
  const db = env.DB;
  const [comments, deepCuts, replies, bestScore, edited, episodes, movies, doubleFeature, shows, rollCredits, flags, following, curator, ratings] =
    await db.batch([
      db.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(target_type = 'episode'), 0) AS ep,
                COALESCE(SUM(target_type = 'show'), 0) AS sh,
                COALESCE(SUM(target_type = 'movie'), 0) AS mv
         FROM comments WHERE user_id = ?1 AND deleted_at IS NULL`
      ).bind(uid),
      db.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM comments c
           LEFT JOIN episodes e ON c.target_type = 'episode' AND e.id = c.target_id
           JOIN shows s ON s.tmdb_id = COALESCE(e.show_id, CASE WHEN c.target_type = 'show' THEN c.target_id END)
           WHERE c.user_id = ?1 AND c.deleted_at IS NULL AND s.first_air_date <= date('now', '-10 years')
         ) AS hit`
      ).bind(uid),
      db.prepare(
        `SELECT COALESCE(MAX(n), 0) AS n FROM (
           SELECT COUNT(*) AS n FROM comments r JOIN comments p ON p.id = r.parent_id
           WHERE p.user_id = ?1 AND r.user_id != ?1 AND r.deleted_at IS NULL GROUP BY r.parent_id
         )`
      ).bind(uid),
      db.prepare(
        `SELECT COALESCE(MAX(s), 0) AS n FROM (
           SELECT SUM(v.value) AS s FROM comment_votes v
           JOIN comments c ON c.id = v.comment_id
           WHERE c.user_id = ?1 AND c.deleted_at IS NULL GROUP BY v.comment_id
         )`
      ).bind(uid),
      db.prepare(
        "SELECT EXISTS(SELECT 1 FROM comment_edits ce JOIN comments c ON c.id = ce.comment_id WHERE c.user_id = ?1) AS hit"
      ).bind(uid),
      db.prepare(
        `SELECT COUNT(*) AS eps,
                COALESCE(SUM(COALESCE(e.runtime_min, 0)), 0) AS mins,
                COALESCE(MAX(ue.play_count), 0) AS maxplay,
                COALESCE(SUM(e.season_number = 1 AND e.number = 1), 0) AS pilots
         FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id WHERE ue.user_id = ?1`
      ).bind(uid),
      db.prepare("SELECT COUNT(*) AS n FROM user_movies WHERE user_id = ?1 AND state = 'watched'").bind(uid),
      db.prepare(
        `SELECT EXISTS(SELECT 1 FROM (
           SELECT 1 FROM user_movies WHERE user_id = ?1 AND state = 'watched' AND watched_at IS NOT NULL
           GROUP BY date(watched_at) HAVING COUNT(*) >= 2
         )) AS hit`
      ).bind(uid),
      db.prepare(
        `SELECT COUNT(*) AS follows, COALESCE(SUM(s.first_air_date < '1990-01-01'), 0) AS vintage
         FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
         WHERE us.user_id = ?1 AND us.state != 'hidden'`
      ).bind(uid),
      // Every aired regular-season episode of some ended show watched. The
      // aired-episode set is checked with NOT EXISTS so specials (season 0)
      // and future-dated entries can't block the unlock. Undated episodes of
      // these ended shows count as aired (metadata gaps, not future runs —
      // see lib/aired.ts), so they must be watched like any other.
      db.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
           WHERE us.user_id = ?1 AND s.status IN ('Ended', 'Canceled')
             AND EXISTS(SELECT 1 FROM episodes e WHERE e.show_id = us.show_id
                          AND e.season_number > 0 AND (e.air_date IS NULL OR e.air_date <= date('now')))
             AND NOT EXISTS(
               SELECT 1 FROM episodes e
               WHERE e.show_id = us.show_id AND e.season_number > 0
                 AND (e.air_date IS NULL OR e.air_date <= date('now'))
                 AND NOT EXISTS(SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)
             )
         ) AS hit`
      ).bind(uid),
      db.prepare("SELECT profile_public, (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = ?1").bind(uid),
      db.prepare(
        "SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?1 AND state = 'active'"
      ).bind(uid),
      db.prepare(
        `SELECT EXISTS(SELECT 1 FROM (
           SELECT 1 FROM custom_list_items li JOIN custom_lists l ON l.id = li.list_id
           WHERE l.user_id = ?1 GROUP BY li.list_id HAVING COUNT(*) >= 10
         )) AS hit`
      ).bind(uid),
      db.prepare(
        `SELECT COALESCE(SUM(score IS NOT NULL), 0) AS rated,
                COALESCE(MAX(score = 1), 0) AS low, COALESCE(MAX(score = 10), 0) AS high,
                COALESCE(MAX(emoji_reaction IS NOT NULL), 0) AS emoji
         FROM ratings WHERE user_id = ?1`
      ).bind(uid),
    ]);

  const one = <T>(r: D1Result) => r.results[0] as T;
  const cm = one<{ total: number; ep: number; sh: number; mv: number }>(comments);
  const ep = one<{ eps: number; mins: number; maxplay: number; pilots: number }>(episodes);
  const sw = one<{ follows: number; vintage: number }>(shows);
  const fl = one<{ profile_public: number; verified: number }>(flags);
  const rt = one<{ rated: number; low: number; high: number; emoji: number }>(ratings);
  const hit = (r: D1Result) => !!one<{ hit: number }>(r).hit;

  const earned: string[] = [];
  const award = (id: string, ok: boolean) => ok && earned.push(id);

  award("first-words", cm.total >= 1);
  award("chatterbox", cm.total >= 10);
  award("town-crier", cm.total >= 50);
  award("scene-stealer", cm.ep >= 1);
  award("series-regular", cm.sh >= 1);
  award("film-critic", cm.mv >= 1);
  award("deep-cuts", hit(deepCuts));
  award("thread-starter", one<{ n: number }>(replies).n >= 5);
  award("crowd-pleaser", one<{ n: number }>(bestScore).n >= 10);
  award("second-thoughts", hit(edited));

  award("first-light", ep.eps >= 1);
  award("century-club", ep.eps >= 100);
  award("kilowatcher", ep.eps >= 1000);
  award("hundred-hours", ep.mins >= 100 * 60);
  award("time-lord", ep.mins >= 1000 * 60);
  award("roll-credits", hit(rollCredits));
  award("pilot-season", ep.pilots >= 10);
  award("deja-view", ep.maxplay >= 2);

  award("movie-night", one<{ n: number }>(movies).n >= 1);
  award("double-feature", hit(doubleFeature));
  award("popcorn-century", one<{ n: number }>(movies).n >= 100);

  award("star-grader", rt.rated >= 50);
  award("full-range", !!rt.low && !!rt.high);
  award("speaks-in-emoji", !!rt.emoji);

  award("packed-lineup", sw.follows >= 25);
  award("vintage-collector", sw.vintage >= 1);
  award("curator", hit(curator));
  award("open-curtains", !!fl.profile_public);
  award("card-carrying", !!fl.verified);
  award("better-together", one<{ n: number }>(following).n >= 1);
  award("entourage", one<{ n: number }>(following).n >= 10);

  if (!earned.length) return;
  await db.batch(
    earned.map((id) =>
      db.prepare("INSERT INTO user_achievements (user_id, achievement_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(uid, id)
    )
  );
}
