import { Hono } from "hono";
import type { AppEnv } from "../env";
import { tmdb, ensureShow, ensureMovie, watchProviders } from "../lib/tmdb";
import { optionalAuth } from "../lib/session";
import { todayInTz } from "../lib/dates";
import { airedCond } from "../lib/aired";
import type { RewatchRef } from "../../shared/rewatch";

// How many dated plays a detail payload ships, newest first. Plays are
// append-only by design, so this array only ever grows: a comfort movie
// logged weekly for three years is 150 rows of JSON and 150 DOM nodes in a
// block that sits above the rating and the comments. Letterboxd paginates the
// diary and Simkl lazy-loads its history popup; we send a season's worth and
// say how many there are (`playsTotal`), which is all the UI needs to print
// "+ N older plays" honestly.
const PLAYS_LIMIT = 25;

// `plays` + the true total, in one query: the window function counts every
// dated play for this title while the LIMIT keeps the payload small. Same
// shape for episodes and movies, so the two pages can't drift.
function playsPayload(rows: any[]): { plays: { watchedAt: string }[]; playsTotal: number } {
  return {
    plays: rows.map((p) => ({ watchedAt: p.watched_at })),
    playsTotal: (rows[0]?.total as number | undefined) ?? rows.length,
  };
}

export const catalog = new Hono<AppEnv>();

// Show/movie/episode detail reads, split out of `catalog` so
// index.ts can mount them BEFORE the auth wall: shared title links must open
// for signed-out visitors. Each route runs optionalAuth — the public catalog
// payload is served to everyone, and the viewer's own state (watched,
// progress, rating, favorite, watchlist) is queried and attached only when a
// valid session cookie is present. Anonymous responses carry `user: null`
// (and `progress: null` on shows) with no per-episode watch fields, so no
// user-scoped data is ever reachable without auth. Anonymous requests are
// also served exclusively from rows already cached in D1 — a cache miss 404s
// without calling ensureShow/ensureMovie, so unauthenticated traffic can
// never trigger TMDB ingestion or D1 writes. GET-only by
// construction; the watch/favorite/follow mutations on neighboring paths
// live in library.ts behind requireAuth.
export const titles = new Hono<AppEnv>();

// Accepts undefined because interposing per-route middleware (optionalAuth)
// widens Hono's inferred param type; Number(undefined) is NaN, so a missing
// param still answers 400.
function intParam(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

catalog.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ results: [] });
  const data = await tmdb(c.env, "/search/multi", { query: q, include_adult: "false" }, 86400);
  const results = (data.results ?? [])
    .filter((r: any) => r.media_type === "tv" || r.media_type === "movie")
    .slice(0, 20)
    .map((r: any) => ({
      type: r.media_type === "tv" ? "show" : "movie",
      id: r.id,
      title: r.media_type === "tv" ? r.name : r.title,
      year: (r.first_air_date || r.release_date || "").slice(0, 4) || null,
      poster: r.poster_path ?? null,
      overview: r.overview ?? null,
    }));
  return c.json({ results });
});

titles.get("/shows/:id", optionalAuth, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);

  // Anonymous viewers (shared links) have no session: no uid to
  // query user state with, and no profile timezone — UTC is the neutral
  // stand-in for the aired cutoff.
  const uid = c.get("uid") ?? null;
  const today = todayInTz(c.get("tz") ?? "UTC");

  // TMDB ingestion is signed-in only. A shared link points at a
  // title the sharer's own page view already synced into D1, so anonymous
  // requests read the cached row and 404 on a miss — they must never reach
  // ensureShow, or an anonymous loop over ids could force-feed TMDB's entire
  // catalog into D1 (unbounded writes, TMDB quota, Worker CPU).
  if (uid != null) await ensureShow(c.env, id);

  const stmts = [
    c.env.DB.prepare("SELECT * FROM shows WHERE tmdb_id = ?1").bind(id),
    c.env.DB.prepare("SELECT id, number, name FROM seasons WHERE show_id = ?1 ORDER BY number").bind(id),
    c.env.DB.prepare(
      `SELECT e.id, e.season_number, e.number, e.title, e.air_date, e.runtime_min, e.overview, e.still_url,
              ${airedCond("?2", "sh")} AS aired
       FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       WHERE e.show_id = ?1 ORDER BY e.season_number, e.number`
    ).bind(id, today),
  ];
  // The viewer's own state — queried only for a signed-in session.
  if (uid != null) {
    stmts.push(
      c.env.DB.prepare("SELECT state, hidden FROM user_shows WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
      c.env.DB.prepare(
        `SELECT ue.episode_id, ue.play_count FROM user_episodes ue
         JOIN episodes e ON e.id = ue.episode_id WHERE ue.user_id = ?1 AND e.show_id = ?2`
      ).bind(uid, id),
      c.env.DB.prepare(
        "SELECT score, emoji_reaction FROM ratings WHERE user_id = ?1 AND target_type = 'show' AND target_id = ?2"
      ).bind(uid, id),
      c.env.DB.prepare(
        `SELECT r.target_id, r.score, r.emoji_reaction FROM ratings r
         JOIN episodes e ON e.id = r.target_id
         WHERE r.user_id = ?1 AND r.target_type = 'episode' AND e.show_id = ?2`
      ).bind(uid, id),
      c.env.DB.prepare(
        `SELECT 1 FROM custom_list_items li JOIN custom_lists l ON l.id = li.list_id
         WHERE l.user_id = ?1 AND l.kind = 'favorites' AND li.target_type = 'show' AND li.target_id = ?2`
      ).bind(uid, id),
      // Rewatch rounds (0043): every round row — the active one (finished_at
      // IS NULL) drives the round chip + progress, the finished ones are the
      // completed-rounds count.
      c.env.DB.prepare(
        "SELECT round, started_at, finished_at FROM user_show_rewatches WHERE user_id = ?1 AND show_id = ?2 ORDER BY round"
      ).bind(uid, id),
      // Episodes played during the active round (a play at watched_at >=
      // started_at — >= so a play stamped exactly at the start counts). Empty
      // when no round is active, so the batch can stay unconditional.
      c.env.DB.prepare(
        `SELECT DISTINCT p.episode_id FROM user_episode_plays p
         JOIN episodes e ON e.id = p.episode_id
         JOIN user_show_rewatches rw ON rw.user_id = p.user_id AND rw.show_id = e.show_id AND rw.finished_at IS NULL
         WHERE p.user_id = ?1 AND e.show_id = ?2 AND p.watched_at >= rw.started_at`
      ).bind(uid, id)
    );
  }
  const [showR, seasonsR, episodesR, userShowR, watchedR, showRatingR, epRatingsR, favR, roundsR, roundPlaysR] =
    await c.env.DB.batch(stmts);

  const show = showR.results[0] as any;
  if (!show) return c.json({ error: "not found" }, 404);

  const showJson = {
    id: show.tmdb_id,
    title: show.title,
    status: show.status,
    firstAirDate: show.first_air_date,
    poster: show.poster_url,
    backdrop: show.backdrop_url,
    overview: show.overview,
    genres: JSON.parse(show.genres_json),
    imdbId: show.imdb_id,
  };
  // Public rows (aired resolved to a boolean); the signed-in branch overlays
  // the viewer's watch state on top.
  const baseEpisodes = (episodesR.results as any[]).map((e) => ({ ...e, aired: !!e.aired }));
  const seasonsFrom = (eps: any[]) =>
    (seasonsR.results as any[]).map((s) => ({
      ...s,
      episodes: eps.filter((e) => e.season_number === s.number),
    }));

  if (uid == null) {
    // Anonymous: catalog content only. `user`/`progress` are explicit nulls
    // (not empty objects) so nothing user-shaped ships without a session,
    // and the per-episode watched/playCount/rating fields are omitted.
    const regular = baseEpisodes.filter((e) => e.season_number > 0);
    return c.json({
      show: showJson,
      seasons: seasonsFrom(baseEpisodes),
      user: null,
      progress: null,
      nextEpisode: regular.find((e) => e.air_date != null && e.air_date > today) ?? null,
      watch: await watchProviders(c.env, "tv", id, showJson.title),
    });
  }

  const watched = new Map((watchedR.results as any[]).map((r) => [r.episode_id, r.play_count]));
  const epRatings = new Map((epRatingsR.results as any[]).map((r) => [r.target_id, r]));

  const rounds = roundsR.results as any[];
  const activeRound = rounds.find((r) => r.finished_at == null) ?? null;
  // Rows come back ordered by round, so the last finished one is the latest.
  const finishedRounds = rounds.filter((r) => r.finished_at != null);
  const lastFinished = finishedRounds[finishedRounds.length - 1] ?? null;
  const playedThisRound = new Set((roundPlaysR.results as any[]).map((r) => r.episode_id));

  // watchedThisRound ships only while a round is active — the field's
  // presence is itself the "round mode" signal, and outside a round the
  // episode rows keep their exact pre-rewatch shape.
  const episodes = baseEpisodes.map((e) => ({
    ...e,
    watched: watched.has(e.id),
    playCount: watched.get(e.id) ?? 0,
    ...(activeRound ? { watchedThisRound: playedThisRound.has(e.id) } : {}),
    rating: epRatings.get(e.id)
      ? { score: epRatings.get(e.id).score, emoji: epRatings.get(e.id).emoji_reaction }
      : null,
  }));

  const regular = episodes.filter((e) => e.season_number > 0);
  const airedEps = regular.filter((e) => e.aired);
  const nextEpisode = regular.find((e) => e.air_date != null && e.air_date > today) ?? null;

  const userShow = userShowR.results[0] as any;
  const showRating = showRatingR.results[0] as any;

  return c.json({
    show: showJson,
    seasons: seasonsFrom(episodes),
    user: {
      // A state-'hidden' row is the hidden-show tombstone (a hidden show that
      // was unfollowed, kept only so the privacy flag survives) — it must
      // not read as followed, or the page would offer Unfollow on a show
      // that isn't tracked.
      followed: !!userShow && userShow.state !== "hidden",
      state: userShow?.state === "hidden" ? null : (userShow?.state ?? null),
      rating: showRating ? { score: showRating.score, emoji: showRating.emoji_reaction } : null,
      favorited: favR.results.length > 0,
      // Per-user privacy flag — drives the show page's eye
      // toggle. Only ever the viewer's own bit; never anyone else's.
      hidden: !!userShow?.hidden,
      // The active rewatch round. Round progress is `roundWatched` — aired
      // regular-season episodes with a this-round play — and it is named that
      // on every surface that reports it (shared/rewatch.ts); `watched` in
      // `progress` below stays the lifetime count it has always been. The two
      // numbers never trade key names between endpoints.
      rewatch: activeRound
        ? ({
            round: activeRound.round,
            startedAt: activeRound.started_at,
            roundWatched: airedEps.filter((e) => (e as any).watchedThisRound).length,
          } satisfies RewatchRef)
        : null,
      // Completed rounds — 0 for most shows; drives the "watched ×N" line.
      rounds: finishedRounds.length,
      // ...and the most recent one's date, so a finished rerun leaves a dated
      // trace on the page instead of only bumping a counter (the round row
      // itself is kept forever; only a *stopped* round is deleted).
      lastRound: lastFinished ? { round: lastFinished.round, finishedAt: lastFinished.finished_at } : null,
    },
    progress: {
      watched: airedEps.filter((e) => e.watched).length,
      aired: airedEps.length,
      total: regular.length,
    },
    nextEpisode,
    watch: await watchProviders(c.env, "tv", id, showJson.title),
  });
});

titles.get("/movies/:id", optionalAuth, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);

  const uid = c.get("uid") ?? null;
  // Signed-in only, mirroring /shows/:id: anonymous requests
  // serve the already-cached row and 404 on a miss — never TMDB.
  if (uid != null) await ensureMovie(c.env, id);
  const stmts = [c.env.DB.prepare("SELECT * FROM movies WHERE tmdb_id = ?1").bind(id)];
  // The viewer's own state — queried only for a signed-in session.
  if (uid != null) {
    stmts.push(
      c.env.DB.prepare("SELECT state, watched_at, play_count FROM user_movies WHERE user_id = ?1 AND movie_id = ?2").bind(uid, id),
      c.env.DB.prepare(
        "SELECT score, emoji_reaction FROM ratings WHERE user_id = ?1 AND target_type = 'movie' AND target_id = ?2"
      ).bind(uid, id),
      c.env.DB.prepare(
        `SELECT 1 FROM custom_list_items li JOIN custom_lists l ON l.id = li.list_id
         WHERE l.user_id = ?1 AND l.kind = 'favorites' AND li.target_type = 'movie' AND li.target_id = ?2`
      ).bind(uid, id),
      // Dated plays (0043), newest first — the movie page's Watch history.
      // Capped; COUNT(*) OVER () rides along so the page can say how many
      // exist without a second round trip.
      c.env.DB.prepare(
        `SELECT watched_at, COUNT(*) OVER () AS total FROM user_movie_plays
         WHERE user_id = ?1 AND movie_id = ?2 ORDER BY watched_at DESC LIMIT ${PLAYS_LIMIT}`
      ).bind(uid, id)
    );
  }
  const [movieR, userR, ratingR, favR, playsR] = await c.env.DB.batch(stmts);

  const movie = movieR.results[0] as any;
  if (!movie) return c.json({ error: "not found" }, 404);

  const movieJson = {
    id: movie.tmdb_id,
    title: movie.title,
    releaseDate: movie.release_date,
    runtime: movie.runtime_min,
    poster: movie.poster_url,
    overview: movie.overview,
    genres: JSON.parse(movie.genres_json),
    imdbId: movie.imdb_id,
  };
  const watch = await watchProviders(c.env, "movie", id, movieJson.title);

  // Anonymous: catalog content only — `user: null`, never an
  // empty user object.
  if (uid == null) return c.json({ movie: movieJson, user: null, watch });

  const user = userR.results[0] as any;
  const rating = ratingR.results[0] as any;

  return c.json({
    movie: movieJson,
    user: {
      state: user?.state ?? null,
      watchedAt: user?.watched_at ?? null,
      playCount: user?.play_count ?? 0,
      // The newest PLAYS_LIMIT dated plays, newest first, plus `playsTotal`:
      // how many dated plays exist in all. playCount can exceed playsTotal
      // for legacy rows whose middle plays predate 0043 — the UI reports
      // those honestly as undated, and anything between playsTotal and
      // plays.length as older plays not shown.
      ...playsPayload(playsR.results as any[]),
      rating: rating ? { score: rating.score, emoji: rating.emoji_reaction } : null,
      favorited: favR.results.length > 0,
    },
    watch,
  });
});

titles.get("/episodes/:id", optionalAuth, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid") ?? null;
  const today = todayInTz(c.get("tz") ?? "UTC");

  const stmts = [
    c.env.DB.prepare(
      `SELECT e.*, s.title AS show_title, s.poster_url AS show_poster, ${airedCond("?2", "s")} AS aired
       FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id WHERE e.id = ?1`
    ).bind(id, today),
  ];
  // The viewer's own state — queried only for a signed-in session.
  if (uid != null) {
    stmts.push(
      c.env.DB.prepare("SELECT watched_at, play_count FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2").bind(uid, id),
      c.env.DB.prepare(
        "SELECT score, emoji_reaction FROM ratings WHERE user_id = ?1 AND target_type = 'episode' AND target_id = ?2"
      ).bind(uid, id),
      // Dated plays (0043), newest first — the episode page's Watch history.
      // Capped like the movie payload, with the true total alongside.
      c.env.DB.prepare(
        `SELECT watched_at, COUNT(*) OVER () AS total FROM user_episode_plays
         WHERE user_id = ?1 AND episode_id = ?2 ORDER BY watched_at DESC LIMIT ${PLAYS_LIMIT}`
      ).bind(uid, id),
      // The show's open rewatch round, and whether THIS episode is already in
      // it. Without this the episode page can't tell round-scoped un-ticking
      // (drops one play) from a full unwatch (drops the row and every play) —
      // the two live on the same button, so the page has to know which one it
      // is about to fire. `>=` never `>`, matching the round rule everywhere
      // else (a play stamped at exactly started_at counts).
      c.env.DB.prepare(
        `SELECT rw.round, rw.started_at,
                EXISTS (SELECT 1 FROM user_episode_plays p
                        WHERE p.user_id = ?1 AND p.episode_id = ?2 AND p.watched_at >= rw.started_at) AS this_round
         FROM user_show_rewatches rw JOIN episodes e ON e.show_id = rw.show_id
         WHERE rw.user_id = ?1 AND e.id = ?2 AND rw.finished_at IS NULL`
      ).bind(uid, id),
      // EVERY round this show has ever had, open or closed — what the Watch
      // history block tags historic plays from. Attribution used to come from
      // the open round alone, so the moment a round auto-completed every play
      // logged inside it went untagged and read exactly like a play from
      // 2018. Trakt and Simkl both keep per-session attribution on plays that
      // are long finished; a round is a dated session and its plays are dated
      // too, so the window [started_at, finished_at] is all it takes.
      c.env.DB.prepare(
        `SELECT rw.round, rw.started_at, rw.finished_at
         FROM user_show_rewatches rw JOIN episodes e ON e.show_id = rw.show_id
         WHERE rw.user_id = ?1 AND e.id = ?2 ORDER BY rw.round`
      ).bind(uid, id)
    );
  }
  const [epR, watchedR, ratingR, playsR, roundR, roundsR] = await c.env.DB.batch(stmts);

  const e = epR.results[0] as any;
  if (!e) return c.json({ error: "not found" }, 404);

  const episodeJson = {
    id: e.id,
    showId: e.show_id,
    showTitle: e.show_title,
    showPoster: e.show_poster,
    season: e.season_number,
    number: e.number,
    title: e.title,
    airDate: e.air_date,
    aired: !!e.aired,
    runtime: e.runtime_min,
    overview: e.overview,
    still: e.still_url,
  };

  // Anonymous: catalog content only.
  if (uid == null) return c.json({ episode: episodeJson, user: null });

  const w = watchedR.results[0] as any;
  const r = ratingR.results[0] as any;
  const rw = roundR.results[0] as any;

  return c.json({
    episode: episodeJson,
    user: {
      watched: !!w,
      watchedAt: w?.watched_at ?? null,
      playCount: w?.play_count ?? 0,
      // The newest PLAYS_LIMIT dated plays + `playsTotal`, exactly as on the
      // movie payload. playCount can exceed playsTotal for legacy rows whose
      // middle plays predate 0043.
      ...playsPayload(playsR.results as any[]),
      // Null outside a round. Same `rewatch` object as everywhere else
      // (shared/rewatch.ts): { round, startedAt } plus the one fact this page
      // needs — whether THIS episode is in the round. That's
      // `watchedThisRound`, a boolean about one episode, and it is never
      // called `roundWatched`, which is always a show-wide count.
      rewatch: rw
        ? ({ round: rw.round, startedAt: rw.started_at, watchedThisRound: !!rw.this_round } satisfies RewatchRef)
        : null,
      // Every round the show has had, oldest first, each with the window its
      // plays fall in (`finishedAt: null` on the open one). Empty for the vast
      // majority of shows — nobody has rewatched them — so this costs the
      // common payload two characters.
      rewatchRounds: (roundsR.results as any[]).map((x) => ({
        round: x.round as number,
        startedAt: x.started_at as string,
        finishedAt: (x.finished_at as string | null) ?? null,
      })),
      rating: r ? { score: r.score, emoji: r.emoji_reaction } : null,
    },
  });
});

// Discovery (free TMDB endpoints, passthrough-mapped)
catalog.get("/trending", async (c) => {
  const [tv, movies] = await Promise.all([
    tmdb(c.env, "/trending/tv/week", {}, 3600),
    tmdb(c.env, "/trending/movie/week", {}, 3600),
  ]);
  const map = (r: any, type: string) => ({
    type,
    id: r.id,
    title: r.name ?? r.title,
    poster: r.poster_path ?? null,
    year: (r.first_air_date || r.release_date || "").slice(0, 4) || null,
  });
  return c.json({
    shows: (tv.results ?? []).slice(0, 18).map((r: any) => map(r, "show")),
    movies: (movies.results ?? []).slice(0, 18).map((r: any) => map(r, "movie")),
  });
});
