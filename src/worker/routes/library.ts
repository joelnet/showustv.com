import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { ensureShow, ensureMovie } from "../lib/tmdb";
import { nowIso, todayInTz, daysAgoInTz } from "../lib/dates";
import { airedCond } from "../lib/aired";
import { notifyFollowersOfWatch } from "../lib/notifications";
import { RECENT_WINDOW_DAYS, STORED_SHOW_STATES, type DerivedShowState } from "../../shared/constants";
import { isAnime } from "../../shared/anime";

export const library = new Hono<AppEnv>();

function intParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// genres_json is a JSON array of TMDB genre names (e.g. ["Animation","Comedy"]);
// always a valid array (NOT NULL DEFAULT '[]'), but parse defensively.
function parseGenres(json: unknown): string[] {
  try {
    const g = JSON.parse(String(json ?? "[]"));
    return Array.isArray(g) ? g : [];
  } catch {
    return [];
  }
}

// Client may send an explicit watched_at (import, backdating); defaults to now.
function watchedAtFrom(body: any): string | null {
  if (body?.watched_at == null) return nowIso();
  const t = Date.parse(String(body.watched_at));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function deriveState(row: { state: string; watched: number; aired: number; total: number; status: string }): DerivedShowState {
  if (row.state === "stopped" || row.state === "watch_later") return row.state as DerivedShowState;
  if (row.watched === 0) return "not_started";
  if (row.watched < row.aired) return "watching";
  const ended = row.status === "Ended" || row.status === "Canceled";
  return ended && row.total > 0 && row.watched >= row.total ? "finished" : "up_to_date";
}

// ---------- Home: Watch Next ----------

// A show is "recently active" — and belongs in the main Watch Next queue
// rather than the "Haven't watched for a while" bucket — when it was watched
// or had an episode air on/after this cutoff date. `since` is 'YYYY-MM-DD';
// last_watched is an ISO datetime and last_aired a date, both of which compare
// correctly against it as strings.
function recentlyActive(lastWatched: string | null, lastAired: string | null, since: string): boolean {
  return (lastWatched != null && lastWatched >= since) || (lastAired != null && lastAired >= since);
}

// "From People You Follow" (issue #128) looks back this far for followees'
// episode watches — the same 30-day window the activity feed uses, so the two
// social surfaces agree on what counts as recent.
const FOLLOWING_WINDOW_MS = 30 * 24 * 3600 * 1000;

library.get("/home", async (c) => {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  // Recent window: a show qualifies for the queue if it was watched, had an
  // episode air, or was followed within RECENT_WINDOW_DAYS. Otherwise it's
  // dormant and lives in the library's "Haven't watched for a while" bucket.
  const recentSince = daysAgoInTz(c.get("tz"), RECENT_WINDOW_DAYS);
  const { results } = await c.env.DB.prepare(
    `WITH cand AS (
       SELECT e.id, e.show_id, e.season_number, e.number, e.title, e.air_date, e.runtime_min, e.overview, e.still_url,
              ROW_NUMBER() OVER (PARTITION BY e.show_id ORDER BY e.season_number, e.number) AS rn,
              COUNT(*) OVER (PARTITION BY e.show_id) AS unwatched_aired
       FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
         AND e.season_number > 0
         AND ${airedCond("?2", "sh")}
         AND NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)
     ),
     last_aired AS (
       SELECT show_id, MAX(air_date) AS air_date FROM episodes
       WHERE season_number > 0 AND air_date IS NOT NULL AND air_date <= ?2
       GROUP BY show_id
     )
     SELECT c.id AS episode_id, c.show_id, c.season_number, c.number, c.title AS episode_title,
            c.air_date, c.runtime_min, c.overview, c.still_url, c.unwatched_aired,
            s.title AS show_title, s.poster_url, s.backdrop_url,
            lw.last_watched, la.air_date AS last_aired,
            CASE WHEN lw.last_watched IS NULL OR lw.last_watched < us.added_at
                 THEN us.added_at ELSE lw.last_watched END AS last_activity
     FROM cand c
     JOIN shows s ON s.tmdb_id = c.show_id
     JOIN user_shows us ON us.show_id = c.show_id AND us.user_id = ?1
     LEFT JOIN (
       SELECT e2.show_id,
              MAX(CASE WHEN ue.last_rewatched_at > ue.watched_at
                       THEN ue.last_rewatched_at ELSE ue.watched_at END) AS last_watched
       FROM user_episodes ue JOIN episodes e2 ON e2.id = ue.episode_id
       WHERE ue.user_id = ?1 GROUP BY e2.show_id
     ) lw ON lw.show_id = c.show_id
     LEFT JOIN last_aired la ON la.show_id = c.show_id
     WHERE c.rn = 1
     ORDER BY last_activity DESC, c.air_date DESC`
  )
    .bind(uid, today)
    .all();

  // Bucket the queue into Continue Watching / Not Started / Haven't Watched
  // in a While by whether the show has been started and is recently active.
  const showTile = (r: any) => ({
    kind: "show" as const,
    id: r.show_id,
    title: r.show_title,
    poster: r.poster_url,
    backdrop: r.backdrop_url,
    still: r.still_url,
    season: r.season_number,
    number: r.number,
    episodeTitle: r.episode_title,
    count: r.unwatched_aired,
  });
  const continueWatching: any[] = [];
  const notStarted: any[] = [];
  const havenWatched: any[] = [];
  for (const r of results as any[]) {
    if (r.last_watched == null) notStarted.push(showTile(r));
    else if (recentlyActive(r.last_watched, r.last_aired, recentSince)) continueWatching.push(showTile(r));
    else havenWatched.push(showTile(r));
  }

  // Upcoming: the soonest unaired episode per followed show.
  const { results: upcomingR } = await c.env.DB.prepare(
    `WITH upc AS (
       SELECT e.id AS episode_id, e.show_id, e.season_number, e.number, e.title AS episode_title, e.air_date,
              s.title AS show_title, s.poster_url, s.backdrop_url,
              ROW_NUMBER() OVER (PARTITION BY e.show_id ORDER BY e.air_date, e.season_number, e.number) AS rn
       FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
       WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
         AND e.season_number > 0 AND e.air_date IS NOT NULL AND e.air_date > ?2
     )
     SELECT episode_id, show_id, season_number, number, episode_title, air_date, show_title, poster_url, backdrop_url
     FROM upc WHERE rn = 1
     ORDER BY air_date, show_title, season_number, number
     LIMIT 30`
  )
    .bind(uid, today)
    .all();
  const upcoming = (upcomingR as any[]).map((r) => ({
    kind: "show" as const,
    id: r.show_id,
    title: r.show_title,
    poster: r.poster_url,
    backdrop: r.backdrop_url,
    still: null,
    season: r.season_number,
    number: r.number,
    episodeTitle: r.episode_title,
    // Date-only 'YYYY-MM-DD'; the query guarantees it exists and is in the
    // future. Feeds the tile's date pill (issue #175).
    airDate: r.air_date,
  }));

  // History: recently watched episodes and movies, newest first. The batch
  // also carries the "From People You Follow" query (issue #128): shows the
  // people you follow watched recently, one tile per show attributed to the
  // most recent watcher (a popular show is one tile, not one per follower).
  // Each tile also carries the exact episode behind that winning watch so the
  // client can name it and deep-link to it (issue #128 follow-up). Tiebreaks
  // preserve the section's original attribution: watchers tied on timestamp
  // still resolve by username first; only then, within the credited watcher's
  // rows (a bulk mark-watched stamps many episodes with one timestamp), does
  // the furthest episode win — the followee's actual progress point.
  const [histEp, histMov, friendsR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT e.show_id AS id, s.title AS show_title, s.poster_url, s.backdrop_url, e.still_url,
              e.season_number, e.number, e.title AS episode_title,
              (CASE WHEN ue.last_rewatched_at > ue.watched_at THEN ue.last_rewatched_at ELSE ue.watched_at END) AS watched_at
       FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id JOIN shows s ON s.tmdb_id = e.show_id
       WHERE ue.user_id = ?1 AND e.season_number > 0
       ORDER BY watched_at DESC LIMIT 30`
    ).bind(uid),
    c.env.DB.prepare(
      `SELECT m.tmdb_id AS id, m.title, m.poster_url, um.watched_at
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watched' AND um.watched_at IS NOT NULL
       ORDER BY um.watched_at DESC LIMIT 30`
    ).bind(uid),
    c.env.DB.prepare(
      `WITH following(fid) AS (
         SELECT followee_id FROM follows WHERE follower_id = ?1 AND state = 'active'
       ),
       fw AS (
         SELECT e.show_id, u.username,
                e.id AS episode_id, e.season_number, e.number, e.title AS episode_title,
                CASE WHEN ue.last_rewatched_at > ue.watched_at
                     THEN ue.last_rewatched_at ELSE ue.watched_at END AS ts
         FROM user_episodes ue
         JOIN following fo ON fo.fid = ue.user_id
         JOIN users u ON u.id = ue.user_id AND u.deleted_at IS NULL
         JOIN episodes e ON e.id = ue.episode_id
         WHERE (ue.watched_at >= ?2 OR ue.last_rewatched_at >= ?2) AND e.season_number > 0
       )
       SELECT f.show_id, f.username, f.episode_id, f.season_number, f.number, f.episode_title,
              s.title AS show_title, s.poster_url, s.backdrop_url
       FROM (SELECT *, ROW_NUMBER() OVER (
               PARTITION BY show_id
               ORDER BY ts DESC, username, season_number DESC, number DESC) AS rn
             FROM fw) f
       JOIN shows s ON s.tmdb_id = f.show_id
       WHERE f.rn = 1
       ORDER BY f.ts DESC
       LIMIT 30`
    ).bind(uid, new Date(Date.now() - FOLLOWING_WINDOW_MS).toISOString()),
  ]);
  const history: any[] = [
    ...(histEp.results as any[]).map((r) => ({
      kind: "show" as const,
      id: r.id,
      title: r.show_title,
      poster: r.poster_url,
      backdrop: r.backdrop_url,
      still: r.still_url,
      season: r.season_number,
      number: r.number,
      episodeTitle: r.episode_title,
      watchedAt: r.watched_at,
    })),
    ...(histMov.results as any[]).map((r) => ({
      kind: "movie" as const,
      id: r.id,
      title: r.title,
      poster: r.poster_url,
      backdrop: null,
      still: null,
      watchedAt: r.watched_at,
    })),
  ]
    .sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1))
    .slice(0, 30);

  const friendsWatched = (friendsR.results as any[]).map((r) => ({
    kind: "show" as const,
    id: r.show_id,
    title: r.show_title,
    poster: r.poster_url,
    backdrop: r.backdrop_url,
    still: null,
    username: r.username,
    episodeId: r.episode_id,
    season: r.season_number,
    number: r.number,
    episodeTitle: r.episode_title,
  }));

  return c.json({ continueWatching, upcoming, havenWatched, notStarted, history, friendsWatched });
});

// ---------- Library & watchlist ----------

library.get("/library", async (c) => {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  const [showsR, moviesR] = await c.env.DB.batch([
    c.env.DB.prepare(
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
       WHERE us.user_id = ?1 AND us.state != 'watch_later'
       ORDER BY s.title`
    ).bind(uid, today),
    c.env.DB.prepare(
      `SELECT um.movie_id AS id, m.title, m.poster_url AS poster, m.genres_json, m.original_language,
         um.watched_at, um.play_count
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watched'
       ORDER BY um.watched_at DESC`
    ).bind(uid),
  ]);

  // A show still being watched but with no watch/air activity in the recent
  // window is "stale" — the library surfaces it under "Haven't watched for a
  // while". Only meaningful for the watching state; other states aren't behind.
  const recentSince = daysAgoInTz(c.get("tz"), RECENT_WINDOW_DAYS);

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

  return c.json({ shows, movies, animeShows, animeMovies });
});

library.get("/watchlist", async (c) => {
  const uid = c.get("uid");
  const [showsR, moviesR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT us.show_id AS id, s.title, s.poster_url AS poster, s.first_air_date
       FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.user_id = ?1 AND us.state = 'watch_later' ORDER BY us.added_at DESC`
    ).bind(uid),
    c.env.DB.prepare(
      `SELECT um.movie_id AS id, m.title, m.poster_url AS poster, m.release_date
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watchlist' ORDER BY rowid DESC`
    ).bind(uid),
  ]);
  return c.json({ shows: showsR.results, movies: moviesR.results });
});

// ---------- Follow / show state ----------

library.put("/shows/:id/follow", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2)
     ON CONFLICT (user_id, show_id) DO UPDATE
       SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_shows.state IN ('watch_later', 'stopped')`
  )
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.delete("/shows/:id/follow", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  // Unfollow keeps watch history (user_episodes) — TV Time behavior.
  await c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2").bind(c.get("uid"), id).run();
  return c.json({ ok: true });
});

// Full removal (issue #20): for accidental adds — wipe every trace of the
// show from this user's account, not just the follow. Unlike unfollow, this
// deletes watch history, ratings, and favorites/list memberships too.
library.delete("/shows/:id/remove", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?2)"
    ).bind(uid, id),
    c.env.DB.prepare(
      "DELETE FROM episode_character_votes WHERE user_id = ?1 AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?2)"
    ).bind(uid, id),
    c.env.DB.prepare(
      `DELETE FROM ratings WHERE user_id = ?1 AND (
         (target_type = 'show' AND target_id = ?2)
         OR (target_type = 'episode' AND target_id IN (SELECT id FROM episodes WHERE show_id = ?2)))`
    ).bind(uid, id),
    c.env.DB.prepare(
      `DELETE FROM custom_list_items WHERE target_type = 'show' AND target_id = ?2
         AND list_id IN (SELECT id FROM custom_lists WHERE user_id = ?1)`
    ).bind(uid, id),
    c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
  ]);
  return c.json({ ok: true });
});

library.put("/shows/:id/state", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const state = String(body.state ?? "");
  if (!id || !(STORED_SHOW_STATES as readonly string[]).includes(state)) return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare(
    `UPDATE user_shows SET state = ?3, last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?1 AND show_id = ?2`
  )
    .bind(c.get("uid"), id, state)
    .run();
  return c.json({ ok: true });
});

library.put("/shows/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO user_shows (user_id, show_id, state) VALUES (?1, ?2, 'watch_later')
     ON CONFLICT (user_id, show_id) DO NOTHING`
  )
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.delete("/shows/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2 AND state = 'watch_later'")
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

// ---------- Favorites ----------
// Favorites live in a system list (custom_lists.kind = 'favorites'),
// auto-created the first time something is favorited.

async function favoritesListId(c: Context<AppEnv>, create: boolean): Promise<number | null> {
  const uid = c.get("uid");
  const row = await c.env.DB.prepare("SELECT id FROM custom_lists WHERE user_id = ?1 AND kind = 'favorites'")
    .bind(uid)
    .first<{ id: number }>();
  if (row) return row.id;
  if (!create) return null;
  const created = await c.env.DB.prepare(
    "INSERT INTO custom_lists (user_id, name, kind) VALUES (?1, 'Favorites', 'favorites') RETURNING id"
  )
    .bind(uid)
    .first<{ id: number }>();
  return created!.id;
}

library.put("/shows/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  const listId = await favoritesListId(c, true);
  await c.env.DB.prepare(
    `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
     SELECT ?1, 'show', ?2, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
     ON CONFLICT (list_id, target_type, target_id) DO NOTHING`
  )
    .bind(listId, id)
    .run();
  return c.json({ ok: true });
});

library.delete("/shows/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const listId = await favoritesListId(c, false);
  if (listId != null) {
    await c.env.DB.prepare("DELETE FROM custom_list_items WHERE list_id = ?1 AND target_type = 'show' AND target_id = ?2")
      .bind(listId, id)
      .run();
  }
  return c.json({ ok: true });
});

library.put("/movies/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureMovie(c.env, id);
  const listId = await favoritesListId(c, true);
  await c.env.DB.prepare(
    `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
     SELECT ?1, 'movie', ?2, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
     ON CONFLICT (list_id, target_type, target_id) DO NOTHING`
  )
    .bind(listId, id)
    .run();
  return c.json({ ok: true });
});

library.delete("/movies/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const listId = await favoritesListId(c, false);
  if (listId != null) {
    await c.env.DB.prepare("DELETE FROM custom_list_items WHERE list_id = ?1 AND target_type = 'movie' AND target_id = ?2")
      .bind(listId, id)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- Mark watched: episode / season / show ----------

library.post("/episodes/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const watchedAt = watchedAtFrom(await c.req.json().catch(() => ({})));
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));

  // Episode meta + whether this user has already watched it. Doubles as the
  // existence check (unknown id → 404) and feeds the "caught up" test below.
  const ep = await c.env.DB.prepare(
    `SELECT e.show_id, e.season_number, ${airedCond("?3", "s")} AS aired, s.title AS show_title,
            EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id) AS already
     FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id WHERE e.id = ?2`
  )
    .bind(uid, id, today)
    .first<{ show_id: number; season_number: number; aired: number; show_title: string; already: number }>();
  if (!ep) return c.json({ error: "unknown episode" }, 404);

  await c.env.DB.batch([
    // Marking an episode implies tracking the show; a watch-later show flips to watching.
    c.env.DB.prepare(
      `INSERT INTO user_shows (user_id, show_id)
       SELECT ?1, e.show_id FROM episodes e WHERE e.id = ?2
       ON CONFLICT (user_id, show_id) DO UPDATE
         SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_shows.state = 'watch_later'`
    ).bind(uid, id),
    // Re-marking a watched episode counts a rewatch.
    c.env.DB.prepare(
      `INSERT INTO user_episodes (user_id, episode_id, watched_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, episode_id) DO UPDATE
         SET play_count = play_count + 1, last_rewatched_at = excluded.watched_at`
    ).bind(uid, id, watchedAt),
  ]);

  // Notify followers (issue #129), off the response path. Only this
  // one-episode "I just watched this" action notifies — the bulk paths
  // (season / watch-all / watch-until) are history backfill, and pinging
  // every follower because someone imported five old seasons is noise.
  // Fan-out dedupes per show per day, so a binge is still one notification.
  c.executionCtx.waitUntil(
    notifyFollowersOfWatch(c.env, uid, "show", ep.show_id, id).catch((e) => console.error("notify failed", e))
  );

  // Confetti trigger (issue #53): this watch just caught the user up when it
  // was a *fresh* watch (not a rewatch) of an aired, regular-season episode
  // and no aired regular-season episode is left unwatched for the show. The
  // freshness + aired guards keep it from firing on rewatches or on shows that
  // were already fully caught up. Specials (season 0) never count, matching the
  // rest of the app's progress accounting.
  let caughtUp = false;
  if (!ep.already && ep.season_number > 0 && ep.aired) {
    const remaining = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
       WHERE e.show_id = ?2 AND e.season_number > 0
         AND ${airedCond("?3", "s")}
         AND NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)`
    )
      .bind(uid, ep.show_id, today)
      .first<{ n: number }>();
    caughtUp = (remaining?.n ?? 0) === 0;
  }

  return c.json({ ok: true, caughtUp, showTitle: ep.show_title });
});

library.delete("/episodes/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2").bind(c.get("uid"), id).run();
  return c.json({ ok: true });
});

async function bulkWatch(c: any, showId: number, seasonNumber: number | null, unwatch: boolean) {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  const seasonCond = seasonNumber == null ? "e.season_number > 0" : "e.season_number = ?4";

  if (unwatch) {
    const sql = `DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id IN
       (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${seasonCond.replace("?4", "?3")})`;
    const stmt = seasonNumber == null ? c.env.DB.prepare(sql).bind(uid, showId) : c.env.DB.prepare(sql).bind(uid, showId, seasonNumber);
    await stmt.run();
  } else {
    const sql = `INSERT INTO user_episodes (user_id, episode_id, watched_at)
       SELECT ?1, e.id, ?3 FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       WHERE e.show_id = ?2 AND ${seasonCond}
         AND ${airedCond(`?${seasonNumber == null ? "4" : "5"}`, "sh")}
       ON CONFLICT (user_id, episode_id) DO NOTHING`;
    const args = seasonNumber == null ? [uid, showId, nowIso(), today] : [uid, showId, nowIso(), seasonNumber, today];
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(uid, showId),
      c.env.DB.prepare(sql).bind(...args),
    ]);
  }
}

library.post("/shows/:id/seasons/:num/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const num = Number(c.req.param("num"));
  if (!id || !Number.isInteger(num) || num < 0) return c.json({ error: "bad request" }, 400);
  await bulkWatch(c, id, num, false);
  return c.json({ ok: true });
});

library.delete("/shows/:id/seasons/:num/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const num = Number(c.req.param("num"));
  if (!id || !Number.isInteger(num) || num < 0) return c.json({ error: "bad request" }, 400);
  await bulkWatch(c, id, num, true);
  return c.json({ ok: true });
});

library.post("/shows/:id/watch-all", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await bulkWatch(c, id, null, false);
  return c.json({ ok: true });
});

// Catch-up: mark everything up to and including SxxEyy watched, one call.
// Regular seasons only — specials (season 0) are never swept in.
library.post("/shows/:id/watch-until", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const season = Number(body.season);
  const number = Number(body.number);
  if (!id || !Number.isInteger(season) || season < 1 || !Number.isInteger(number) || number < 1)
    return c.json({ error: "bad request" }, 400);

  const uid = c.get("uid");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(uid, id),
    c.env.DB.prepare(
      `INSERT INTO user_episodes (user_id, episode_id, watched_at)
       SELECT ?1, e.id, ?3 FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       WHERE e.show_id = ?2 AND e.season_number > 0
         AND (e.season_number < ?4 OR (e.season_number = ?4 AND e.number <= ?5))
         AND ${airedCond("?6", "sh")}
       ON CONFLICT (user_id, episode_id) DO NOTHING`
    ).bind(uid, id, nowIso(), season, number, todayInTz(c.get("tz"))),
  ]);
  return c.json({ ok: true });
});

// ---------- Movies ----------

library.post("/movies/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const watchedAt = watchedAtFrom(await c.req.json().catch(() => ({})));
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  await ensureMovie(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO user_movies (user_id, movie_id, state, watched_at, play_count) VALUES (?1, ?2, 'watched', ?3, 1)
     ON CONFLICT (user_id, movie_id) DO UPDATE
       SET state = 'watched', watched_at = excluded.watched_at, play_count = user_movies.play_count + 1`
  )
    .bind(c.get("uid"), id, watchedAt)
    .run();
  // Notify followers (issue #129), off the response path — see the episode
  // watch route above for the reasoning.
  c.executionCtx.waitUntil(
    notifyFollowersOfWatch(c.env, c.get("uid"), "movie", id).catch((e) => console.error("notify failed", e))
  );
  return c.json({ ok: true });
});

library.delete("/movies/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM user_movies WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watched'")
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.put("/movies/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureMovie(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO user_movies (user_id, movie_id, state, play_count) VALUES (?1, ?2, 'watchlist', 0)
     ON CONFLICT (user_id, movie_id) DO NOTHING`
  )
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.delete("/movies/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM user_movies WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watchlist'")
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});
