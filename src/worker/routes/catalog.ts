import { Hono } from "hono";
import type { AppEnv } from "../env";
import { tmdb, ensureShow, ensureMovie, watchProviders } from "../lib/tmdb";
import { todayInTz } from "../lib/dates";

export const catalog = new Hono<AppEnv>();

function intParam(v: string): number | null {
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

catalog.get("/shows/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);

  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));

  const [showR, seasonsR, episodesR, userShowR, watchedR, showRatingR, epRatingsR, favR] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM shows WHERE tmdb_id = ?1").bind(id),
    c.env.DB.prepare("SELECT id, number, name FROM seasons WHERE show_id = ?1 ORDER BY number").bind(id),
    c.env.DB.prepare(
      `SELECT id, season_number, number, title, air_date, runtime_min, overview, still_url
       FROM episodes WHERE show_id = ?1 ORDER BY season_number, number`
    ).bind(id),
    c.env.DB.prepare("SELECT state FROM user_shows WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
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
  ]);

  const show = showR.results[0] as any;
  if (!show) return c.json({ error: "not found" }, 404);

  const watched = new Map((watchedR.results as any[]).map((r) => [r.episode_id, r.play_count]));
  const epRatings = new Map((epRatingsR.results as any[]).map((r) => [r.target_id, r]));

  const episodes = (episodesR.results as any[]).map((e) => ({
    ...e,
    aired: e.air_date != null && e.air_date <= today,
    watched: watched.has(e.id),
    playCount: watched.get(e.id) ?? 0,
    rating: epRatings.get(e.id)
      ? { score: epRatings.get(e.id).score, emoji: epRatings.get(e.id).emoji_reaction }
      : null,
  }));

  const seasons = (seasonsR.results as any[]).map((s) => ({
    ...s,
    episodes: episodes.filter((e) => e.season_number === s.number),
  }));

  const regular = episodes.filter((e) => e.season_number > 0);
  const airedEps = regular.filter((e) => e.aired);
  const nextEpisode = regular.find((e) => e.air_date != null && e.air_date > today) ?? null;

  const userShow = userShowR.results[0] as any;
  const showRating = showRatingR.results[0] as any;

  return c.json({
    show: {
      id: show.tmdb_id,
      title: show.title,
      status: show.status,
      firstAirDate: show.first_air_date,
      poster: show.poster_url,
      backdrop: show.backdrop_url,
      overview: show.overview,
      genres: JSON.parse(show.genres_json),
      imdbId: show.imdb_id,
    },
    seasons,
    user: {
      followed: !!userShow,
      state: userShow?.state ?? null,
      rating: showRating ? { score: showRating.score, emoji: showRating.emoji_reaction } : null,
      favorited: favR.results.length > 0,
    },
    progress: {
      watched: airedEps.filter((e) => e.watched).length,
      aired: airedEps.length,
      total: regular.length,
    },
    nextEpisode,
    providers: await watchProviders(c.env, "tv", id),
  });
});

catalog.get("/movies/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureMovie(c.env, id);

  const uid = c.get("uid");
  const [movieR, userR, ratingR, favR] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM movies WHERE tmdb_id = ?1").bind(id),
    c.env.DB.prepare("SELECT state, watched_at, play_count FROM user_movies WHERE user_id = ?1 AND movie_id = ?2").bind(uid, id),
    c.env.DB.prepare(
      "SELECT score, emoji_reaction FROM ratings WHERE user_id = ?1 AND target_type = 'movie' AND target_id = ?2"
    ).bind(uid, id),
    c.env.DB.prepare(
      `SELECT 1 FROM custom_list_items li JOIN custom_lists l ON l.id = li.list_id
       WHERE l.user_id = ?1 AND l.kind = 'favorites' AND li.target_type = 'movie' AND li.target_id = ?2`
    ).bind(uid, id),
  ]);

  const movie = movieR.results[0] as any;
  if (!movie) return c.json({ error: "not found" }, 404);
  const user = userR.results[0] as any;
  const rating = ratingR.results[0] as any;

  return c.json({
    movie: {
      id: movie.tmdb_id,
      title: movie.title,
      releaseDate: movie.release_date,
      runtime: movie.runtime_min,
      poster: movie.poster_url,
      overview: movie.overview,
      genres: JSON.parse(movie.genres_json),
      imdbId: movie.imdb_id,
    },
    user: {
      state: user?.state ?? null,
      watchedAt: user?.watched_at ?? null,
      playCount: user?.play_count ?? 0,
      rating: rating ? { score: rating.score, emoji: rating.emoji_reaction } : null,
      favorited: favR.results.length > 0,
    },
    providers: await watchProviders(c.env, "movie", id),
  });
});

catalog.get("/episodes/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");

  const [epR, watchedR, ratingR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT e.*, s.title AS show_title, s.poster_url AS show_poster
       FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id WHERE e.id = ?1`
    ).bind(id),
    c.env.DB.prepare("SELECT watched_at, play_count FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2").bind(uid, id),
    c.env.DB.prepare(
      "SELECT score, emoji_reaction FROM ratings WHERE user_id = ?1 AND target_type = 'episode' AND target_id = ?2"
    ).bind(uid, id),
  ]);

  const e = epR.results[0] as any;
  if (!e) return c.json({ error: "not found" }, 404);
  const w = watchedR.results[0] as any;
  const r = ratingR.results[0] as any;

  return c.json({
    episode: {
      id: e.id,
      showId: e.show_id,
      showTitle: e.show_title,
      showPoster: e.show_poster,
      season: e.season_number,
      number: e.number,
      title: e.title,
      airDate: e.air_date,
      runtime: e.runtime_min,
      overview: e.overview,
      still: e.still_url,
    },
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
