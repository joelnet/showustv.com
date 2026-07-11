// The library payload, shared — like lib/stats.ts — by the owner's authed
// GET /library (routes/library.ts) and the public library endpoint
// GET /public/library/:username (routes/public.ts, issue #245). One query
// path means the public page can never drift from what the owner's Library
// shows; the CALLER decides who may see it (the public route applies the
// profile-visibility gate before ever invoking this).

import { todayInTz, daysAgoInTz } from "./dates";
import { airedCond } from "./aired";
import { RECENT_WINDOW_DAYS, type DerivedShowState } from "../../shared/constants";
import { isAnime } from "../../shared/anime";

// The anime test as a SQL predicate — the twin of shared/anime.ts isAnime()
// (Animation genre + Japanese origin); KEEP THE TWO IN SYNC. Needed where a
// query must LIMIT per section (the profile history rows, issue #245): a
// fetch-then-split-in-JS would let 40 recent anime watches starve the Shows
// row of older non-anime ones. json_each is safe here: genres_json is
// NOT NULL DEFAULT '[]' and only ever written as serialized JSON from TMDB.
// COALESCE keeps a NULL original_language (not yet resynced, migration 0016)
// classified as not-anime instead of vanishing from both branches.
export function animeCond(t: string): string {
  return `(COALESCE(${t}.original_language, '') = 'ja'
     AND EXISTS (SELECT 1 FROM json_each(${t}.genres_json) WHERE json_each.value = 'Animation'))`;
}

// genres_json is a JSON array of TMDB genre names (e.g. ["Animation","Comedy"]);
// always a valid array (NOT NULL DEFAULT '[]'), but parse defensively.
export function parseGenres(json: unknown): string[] {
  try {
    const g = JSON.parse(String(json ?? "[]"));
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}

function deriveState(row: { state: string; watched: number; aired: number; total: number; status: string }): DerivedShowState {
  if (row.state === "stopped" || row.state === "watch_later") return row.state as DerivedShowState;
  if (row.watched === 0) return "not_started";
  if (row.watched < row.aired) return "watching";
  const ended = row.status === "Ended" || row.status === "Canceled";
  return ended && row.total > 0 && row.watched >= row.total ? "finished" : "up_to_date";
}

// A show is "recently active" — and belongs in the main Watch Next queue
// rather than the "Haven't watched for a while" bucket — when it was watched
// or had an episode air on/after this cutoff date. `since` is 'YYYY-MM-DD';
// last_watched is an ISO datetime and last_aired a date, both of which compare
// correctly against it as strings.
export function recentlyActive(lastWatched: string | null, lastAired: string | null, since: string): boolean {
  return (lastWatched != null && lastWatched >= since) || (lastAired != null && lastAired >= since);
}

// `tz` shapes "today" for the aired counts and the recent-activity window: the
// viewer's own timezone on the authed route, the signed-in viewer's (or UTC
// for anonymous visitors) on the public one — a few hours' skew around
// midnight at most, same as the owner's own view shifts when they travel.
export async function libraryPayload(db: D1Database, uid: number, tz: string) {
  const today = todayInTz(tz);
  const [showsR, moviesR] = await db.batch([
    db
      .prepare(
        `SELECT us.show_id AS id, us.state, s.title, s.poster_url AS poster, s.status,
         s.genres_json, s.original_language,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0
            AND ${airedCond("?2", "s")}) AS aired,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0) AS total,
         (SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = us.user_id AND e.show_id = us.show_id AND e.season_number > 0) AS watched,
         (SELECT MAX(CASE WHEN ue.last_rewatched_at > ue.watched_at
                          THEN ue.last_rewatched_at ELSE ue.watched_at END)
            FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = us.user_id AND e.show_id = us.show_id) AS last_watched_at,
         (SELECT MAX(e.air_date) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0
            AND e.air_date IS NOT NULL AND e.air_date <= ?2) AS last_aired
       FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.user_id = ?1 AND us.state NOT IN ('watch_later', 'hidden')
       ORDER BY s.title`
      )
      .bind(uid, today),
    db
      .prepare(
        `SELECT um.movie_id AS id, m.title, m.poster_url AS poster, m.genres_json, m.original_language,
         um.watched_at, um.play_count
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watched'
       ORDER BY um.watched_at DESC`
      )
      .bind(uid),
  ]);

  // A show still being watched but with no watch/air activity in the recent
  // window is "stale" — the library surfaces it under "Haven't watched for a
  // while". Only meaningful for the watching state; other states aren't behind.
  const recentSince = daysAgoInTz(tz, RECENT_WINDOW_DAYS);

  // Anime (Animation genre + Japanese origin) gets its own tab, so it must not
  // also appear under Shows or Movies. Partition each set with the shared
  // isAnime helper, stripping the classification-only columns from the payload.
  const shows: any[] = [];
  const animeShows: any[] = [];
  for (const r of showsR.results as any[]) {
    const { genres_json, original_language, ...rest } = r;
    const derivedState = deriveState(r);
    const item = {
      ...rest,
      derivedState,
      stale: derivedState === "watching" && !recentlyActive(r.last_watched_at, r.last_aired, recentSince),
    };
    (isAnime(parseGenres(genres_json), original_language) ? animeShows : shows).push(item);
  }

  const movies: any[] = [];
  const animeMovies: any[] = [];
  for (const r of moviesR.results as any[]) {
    const { genres_json, original_language, ...rest } = r;
    (isAnime(parseGenres(genres_json), original_language) ? animeMovies : movies).push(rest);
  }

  return { shows, movies, animeShows, animeMovies };
}
