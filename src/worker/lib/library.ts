// The library payload, shared — like lib/stats.ts — by the owner's authed
// GET /library (routes/library.ts) and the public library endpoint
// GET /public/library/:username (routes/public.ts). One query
// path means the public page can never drift from what the owner's Library
// shows; the CALLER decides who may see it (the public route applies the
// profile-visibility gate before ever invoking this).

import { todayInTz, daysAgoInTz } from "./dates";
import { airedCond } from "./aired";
import { RECENT_WINDOW_DAYS, type DerivedShowState } from "../../shared/constants";
import { isAnime } from "../../shared/anime";
import type { RewatchRef } from "../../shared/rewatch";

// The anime test as a SQL predicate — the twin of shared/anime.ts isAnime()
// (Animation genre + Japanese origin); KEEP THE TWO IN SYNC. Needed where a
// query must LIMIT per section (the profile history rows): a
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
//
// `opts.watchlist` opts IN to the watchlistShows / watchlistMovies buckets:
// the Library's Watch Later subtabs under Shows and Movies.
// Opt-in rather than strip-on-the-way-out because the watchlist is private
// planning shown on no public surface — the public route spreads
// this payload into its response verbatim, so the buckets must not exist
// unless a caller explicitly asks for them.
//
// `opts.includeHidden` opts IN to shows the user hid — same
// safe-by-default posture: only the owner's authed GET /library passes it, so
// the public library can never serve a hidden show even if a future caller
// forgets to think about it. Owner rows then carry a `hidden` flag so the
// Library can mark them; the public payload never grows the field.
//
// `opts.rewatch` opts IN to rewatch round-awareness (0043): shows with an
// active round gain `rewatch: { round, startedAt, roundWatched }` — round
// progress under its own key, never displacing `watched`, which keeps meaning
// exactly what it means on every other endpoint (see shared/rewatch.ts for
// the one vocabulary all three surfaces speak) — and every row gains
// `rounds`, the completed-round count behind its ×N badge. Opt-in for the
// same reason as the flags above: the public library keeps an unchanged shape
// — public rewatch surfaces are out of scope.
export async function libraryPayload(
  db: D1Database,
  uid: number,
  tz: string,
  opts?: { watchlist?: boolean; includeHidden?: boolean; rewatch?: boolean }
) {
  const today = todayInTz(tz);
  // `watched` is the LIFETIME count on every row, with or without rewatch —
  // distinct aired-or-not regular-season episodes ever watched, the number
  // this payload has always carried. Round progress ships beside it under
  // `rewatch.roundWatched` rather than swapping into its key.
  const lifetimeWatched = `(SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = us.user_id AND e.show_id = us.show_id AND e.season_number > 0)`;
  // Round progress, and it must count exactly what the show page counts:
  // AIRED regular-season episodes with a this-round play (routes/catalog.ts
  // filters its round tally to airedEps, and completeRoundIfDone only waits
  // on aired ones). Without the aired predicate a play on an episode whose
  // air_date is in the future — a TMDB resync moving a date, or a mark made
  // either side of the tz midnight boundary — puts the Library card one ahead
  // of the show page for the same round, and can read N/N-1 "complete" on a
  // round the server won't close.
  //
  // Driven FROM episodes (show_id + season, a covering-index range) with a
  // by-PK probe into the plays table, never the reverse: user_episode_plays
  // is keyed (user_id, episode_id, watched_at), so `EXISTS` here is a direct
  // seek, while a `FROM plays JOIN episodes` form scans every play the user
  // owns once per show. The CASE guard is load bearing too: with no round
  // joined there is nothing to count, and `>= NULL` would make the server
  // prove that per row.
  const roundWatched = opts?.rewatch
    ? `CASE WHEN rw.show_id IS NULL THEN NULL ELSE
         (SELECT COUNT(*) FROM episodes e
            WHERE e.show_id = us.show_id AND e.season_number > 0
              AND ${airedCond("?2", "s")}
              AND EXISTS (SELECT 1 FROM user_episode_plays p
                          WHERE p.user_id = us.user_id AND p.episode_id = e.id
                            AND p.watched_at >= rw.started_at)) END AS round_watched,
       (SELECT COUNT(*) FROM user_show_rewatches dr
          WHERE dr.user_id = us.user_id AND dr.show_id = us.show_id AND dr.finished_at IS NOT NULL) AS rounds_done,`
    : "";
  const stmts = [
    db
      .prepare(
        `SELECT us.show_id AS id, us.state, us.hidden, s.title, s.poster_url AS poster, s.status,
         s.genres_json, s.original_language,
         ${opts?.rewatch ? "rw.round AS rewatch_round, rw.started_at AS rewatch_started," : ""}
         ${roundWatched}
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0
            AND ${airedCond("?2", "s")}) AS aired,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0) AS total,
         ${lifetimeWatched} AS watched,
         lw.last_watched_at AS last_watched_at,
         (SELECT MAX(e.air_date) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0
            AND e.air_date IS NOT NULL AND e.air_date <= ?2) AS last_aired
       FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
       -- Last watch = the newest dated play, grouped ONCE for the whole
       -- library rather than correlated per show. As a subquery per row it
       -- has only one index to work with (user_id, watched_at), so it walks
       -- every play the account owns and probes episodes to test show_id —
       -- 13.8k rows × 531 shows on this account, 7.2s for the app's primary
       -- screen (and rows_read is billed on D1). One pass + a hash join is
       -- the same shape /home's lw CTE uses, and lands at 0.2s.
       LEFT JOIN (SELECT e2.show_id AS show_id, MAX(p.watched_at) AS last_watched_at
                  FROM user_episode_plays p JOIN episodes e2 ON e2.id = p.episode_id
                  WHERE p.user_id = ?1 GROUP BY e2.show_id) lw ON lw.show_id = us.show_id
       ${
         opts?.rewatch
           ? `LEFT JOIN (SELECT show_id, round, started_at FROM user_show_rewatches
              WHERE user_id = ?1 AND finished_at IS NULL) rw ON rw.show_id = us.show_id`
           : ""
       }
       WHERE us.user_id = ?1 AND us.state NOT IN ('watch_later', 'hidden')
         ${opts?.includeHidden ? "" : "AND us.hidden = 0"}
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
  ];
  if (opts?.watchlist) {
    // The Watch Later buckets: poster-card rows only, both ordered by when
    // they were saved. Movies use user_movies.added_at (0038); rows predating
    // it are NULL — last under DESC — falling back to movie_id DESC, the
    // proxy this query used before the column existed (it reproduced the
    // retired GET /watchlist's `ORDER BY rowid DESC`, which resolved to
    // movies.rowid, i.e. the same tmdb_id).
    stmts.push(
      db
        .prepare(
          `SELECT us.show_id AS id, s.title, s.poster_url AS poster
         FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
         WHERE us.user_id = ?1 AND us.state = 'watch_later' ORDER BY us.added_at DESC`
        )
        .bind(uid),
      db
        .prepare(
          `SELECT um.movie_id AS id, m.title, m.poster_url AS poster
         FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
         WHERE um.user_id = ?1 AND um.state = 'watchlist'
         ORDER BY um.added_at DESC, um.movie_id DESC`
        )
        .bind(uid)
    );
  }
  const batchR = await db.batch(stmts);
  const [showsR, moviesR] = batchR;

  // A show still being watched but with no watch/air activity in the recent
  // window is "stale" — the same recency split Watch Next uses for its
  // "Haven't watched for a while" bucket. The Library's Watching tab
  // includes stale shows; the flag rides along for any surface that
  // wants the distinction. Only meaningful for the watching state.
  const recentSince = daysAgoInTz(tz, RECENT_WINDOW_DAYS);

  // Anime (Animation genre + Japanese origin) gets its own tab, so it must not
  // also appear under Shows or Movies. Partition each set with the shared
  // isAnime helper, stripping the classification-only columns from the payload.
  const shows: any[] = [];
  const animeShows: any[] = [];
  for (const r of showsR.results as any[]) {
    const { genres_json, original_language, hidden, rewatch_round, rewatch_started, round_watched, rounds_done, ...rest } =
      r;
    // A show mid-round is always "watching" — deriveState would read a
    // fresh round's 0 this-round episodes as not_started. The round's start
    // also counts as watch activity for staleness, so a rewatch begun on a
    // long-finished show doesn't start life in the stale bucket.
    const derivedState = rewatch_round != null ? "watching" : deriveState(r);
    const lastActive =
      rewatch_started != null && (r.last_watched_at == null || rewatch_started > r.last_watched_at)
        ? rewatch_started
        : r.last_watched_at;
    // The active round, for the Library card's ↻ ROUND N badge (opted-in rows
    // only; rewatch_round is simply never selected otherwise). Round progress
    // rides INSIDE it as `roundWatched` — the row's `watched` stays the
    // lifetime count it is everywhere else, so the card can show both without
    // either endpoint having to explain which number it means this time.
    const rewatch: RewatchRef | null =
      rewatch_round != null
        ? { round: rewatch_round, startedAt: rewatch_started, roundWatched: round_watched ?? 0 }
        : null;
    const item = {
      ...rest,
      // The hidden flag ships only on the owner's opted-in
      // payload — the public rows are pre-filtered to hidden = 0, so the
      // field would only be dead weight (and shape drift) there.
      ...(opts?.includeHidden ? { hidden: !!hidden } : {}),
      ...(rewatch ? { rewatch } : {}),
      // Completed rounds — times-through = rounds + 1, the card's ×N. Always
      // present on a rewatch-aware payload, 0 and all: "this show has no
      // rounds" and "this client is talking to an older server" must not look
      // identical, and GET /shows/:id has always sent the 0.
      ...(opts?.rewatch ? { rounds: rounds_done ?? 0 } : {}),
      derivedState,
      stale: derivedState === "watching" && !recentlyActive(lastActive, r.last_aired, recentSince),
    };
    (isAnime(parseGenres(genres_json), original_language) ? animeShows : shows).push(item);
  }

  const movies: any[] = [];
  const animeMovies: any[] = [];
  for (const r of moviesR.results as any[]) {
    const { genres_json, original_language, ...rest } = r;
    (isAnime(parseGenres(genres_json), original_language) ? animeMovies : movies).push(rest);
  }

  const base = { shows, movies, animeShows, animeMovies };
  if (!opts?.watchlist) return base;

  // The watchlist buckets are deliberately NOT anime-split: watch-later is a
  // single planning list per medium (exactly what the old Watchlist tab
  // held), and the anime partition above only applies to tracked/watched
  // titles. No duplication either way — a watch-later title lives only under
  // Watch Later, and moves to its (possibly Anime) home once followed/watched.
  const [, , wlShowsR, wlMoviesR] = batchR;
  return { ...base, watchlistShows: wlShowsR.results, watchlistMovies: wlMoviesR.results };
}
