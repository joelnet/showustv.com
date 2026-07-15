import { Hono } from "hono";
import type { AppEnv } from "../env";
import { tmdb, ensureShow, ensureMovie, watchProviders } from "../lib/tmdb";
import { optionalAuth } from "../lib/session";
import { todayInTz } from "../lib/dates";
import { airedCond } from "../lib/aired";

export const catalog = new Hono<AppEnv>();

// Show/movie/episode detail reads (issue #159), split out of `catalog` so
// index.ts can mount them BEFORE the auth wall: shared title links must open
// for signed-out visitors. Each route runs optionalAuth — the public catalog
// payload is served to everyone, and the viewer's own state (watched,
// progress, rating, favorite, watchlist) is queried and attached only when a
// valid session cookie is present. Anonymous responses carry `user: null`
// (and `progress: null` on shows) with no per-episode watch fields, so no
// user-scoped data is ever reachable without auth. Anonymous requests are
// also served exclusively from rows already cached in D1 — a cache miss 404s
// without calling ensureShow/ensureMovie, so unauthenticated traffic can
// never trigger TMDB ingestion or D1 writes (issue #213). GET-only by
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

  // Anonymous viewers (shared links, issue #159) have no session: no uid to
  // query user state with, and no profile timezone — UTC is the neutral
  // stand-in for the aired cutoff.
  const uid = c.get("uid") ?? null;
  const today = todayInTz(c.get("tz") ?? "UTC");

  // TMDB ingestion is signed-in only (issue #213). A shared link points at a
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
      ).bind(uid, id)
    );
  }
  const [showR, seasonsR, episodesR, userShowR, watchedR, showRatingR, epRatingsR, favR] = await c.env.DB.batch(stmts);

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

  const episodes = baseEpisodes.map((e) => ({
    ...e,
    watched: watched.has(e.id),
    playCount: watched.get(e.id) ?? 0,
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
      // A state-'hidden' row is the issue-#260 tombstone (a hidden show that
      // was unfollowed, kept only so the privacy flag survives) — it must
      // not read as followed, or the page would offer Unfollow on a show
      // that isn't tracked.
      followed: !!userShow && userShow.state !== "hidden",
      state: userShow?.state === "hidden" ? null : (userShow?.state ?? null),
      rating: showRating ? { score: showRating.score, emoji: showRating.emoji_reaction } : null,
      favorited: favR.results.length > 0,
      // Per-user privacy flag (issue #260) — drives the show page's eye
      // toggle. Only ever the viewer's own bit; never anyone else's.
      hidden: !!userShow?.hidden,
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
  // Signed-in only, mirroring /shows/:id (issue #213): anonymous requests
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
      ).bind(uid, id)
    );
  }
  const [movieR, userR, ratingR, favR] = await c.env.DB.batch(stmts);

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

  // Anonymous (issue #159): catalog content only — `user: null`, never an
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
      ).bind(uid, id)
    );
  }
  const [epR, watchedR, ratingR] = await c.env.DB.batch(stmts);

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

  // Anonymous (issue #159): catalog content only.
  if (uid == null) return c.json({ episode: episodeJson, user: null });

  const w = watchedR.results[0] as any;
  const r = ratingR.results[0] as any;

  return c.json({
    episode: episodeJson,
    user: {
      watched: !!w,
      watchedAt: w?.watched_at ?? null,
      playCount: w?.play_count ?? 0,
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
