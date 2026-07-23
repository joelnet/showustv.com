// Watch stats shared by the own-profile and public-profile endpoints.
//
// "Time watched" sums runtime_min over the user's watched episodes plus
// watched movies (the "TV time" tile covers both). TMDB
// omits per-episode runtimes for plenty of (mostly older) episodes, so a NULL
// runtime falls back to the average runtime of that show's episodes that do
// have one; a show with no runtimes at all contributes 0 rather than a guess.
// Movie runtimes are nearly always present on TMDB, so a NULL there just
// contributes 0 — no fallback. Rewatches are not multiplied in — an episode
// or movie counts once.
//
// "Movies watched" counts ALL watched movies, anime movies included, the
// same way "Shows watched" counts anime shows: the anime split is a
// library-tab presentation concern, not a stats one.

export interface WatchStats {
  episodesWatched: number;
  showsWatched: number;
  moviesWatched: number;
  minutesWatched: number;
}

export function statsQuery(db: D1Database, uid: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS episodes,
              COUNT(DISTINCT e.show_id) AS shows,
              (SELECT COUNT(*) FROM user_movies um
               WHERE um.user_id = ?1 AND um.state = 'watched') AS movies,
              CAST(ROUND(COALESCE(SUM(COALESCE(e.runtime_min, sr.avg_runtime, 0)), 0)) AS INTEGER)
                + (SELECT COALESCE(SUM(COALESCE(m.runtime_min, 0)), 0)
                   FROM user_movies um2 JOIN movies m ON m.tmdb_id = um2.movie_id
                   WHERE um2.user_id = ?1 AND um2.state = 'watched') AS minutes
       FROM user_episodes ue
       JOIN episodes e ON e.id = ue.episode_id
       LEFT JOIN (SELECT e2.show_id, AVG(e2.runtime_min) AS avg_runtime
                  FROM episodes e2
                  WHERE e2.runtime_min IS NOT NULL
                    AND e2.show_id IN (SELECT e3.show_id FROM user_episodes ue3
                                       JOIN episodes e3 ON e3.id = ue3.episode_id
                                       WHERE ue3.user_id = ?1)
                  GROUP BY e2.show_id) sr
         ON sr.show_id = e.show_id
       WHERE ue.user_id = ?1`
    )
    .bind(uid);
}

export function statsFromRow(row: unknown): WatchStats {
  const r = (row ?? {}) as { episodes?: number; shows?: number; movies?: number; minutes?: number };
  return {
    episodesWatched: r.episodes ?? 0,
    showsWatched: r.shows ?? 0,
    moviesWatched: r.movies ?? 0,
    minutesWatched: r.minutes ?? 0,
  };
}
