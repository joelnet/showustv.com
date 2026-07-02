import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { ensureShow, ensureMovie } from "../lib/tmdb";
import { nowIso, todayInTz } from "../lib/dates";
import { STORED_SHOW_STATES, type DerivedShowState } from "../../shared/constants";

export const library = new Hono<AppEnv>();

function intParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
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

// Shows whose last activity (most recent of: last watched episode, follow
// date) is older than this split into the "Haven't watched for a while"
// bucket instead of the main queue.
const STALE_MS = 183 * 24 * 3600 * 1000; // ~6 months

library.get("/watch-next", async (c) => {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  const { results } = await c.env.DB.prepare(
    `WITH cand AS (
       SELECT e.id, e.show_id, e.season_number, e.number, e.title, e.air_date, e.runtime_min, e.overview, e.still_url,
              ROW_NUMBER() OVER (PARTITION BY e.show_id ORDER BY e.season_number, e.number) AS rn,
              COUNT(*) OVER (PARTITION BY e.show_id) AS unwatched_aired
       FROM episodes e
       WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
         AND e.season_number > 0
         AND e.air_date IS NOT NULL AND e.air_date <= ?2
         AND NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)
     )
     SELECT c.id AS episode_id, c.show_id, c.season_number, c.number, c.title AS episode_title,
            c.air_date, c.runtime_min, c.overview, c.still_url, c.unwatched_aired,
            s.title AS show_title, s.poster_url, s.backdrop_url,
            CASE WHEN lw.last_watched IS NULL OR lw.last_watched < us.added_at
                 THEN us.added_at ELSE lw.last_watched END AS last_activity
     FROM cand c
     JOIN shows s ON s.tmdb_id = c.show_id
     JOIN user_shows us ON us.show_id = c.show_id AND us.user_id = ?1
     LEFT JOIN (
       SELECT e2.show_id, MAX(ue.watched_at) AS last_watched
       FROM user_episodes ue JOIN episodes e2 ON e2.id = ue.episode_id
       WHERE ue.user_id = ?1 GROUP BY e2.show_id
     ) lw ON lw.show_id = c.show_id
     WHERE c.rn = 1
     ORDER BY last_activity DESC, c.air_date DESC`
  )
    .bind(uid, today)
    .all();

  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const toItem = (r: any) => ({
    show: { id: r.show_id, title: r.show_title, poster: r.poster_url, backdrop: r.backdrop_url },
    episode: {
      id: r.episode_id,
      season: r.season_number,
      number: r.number,
      title: r.episode_title,
      airDate: r.air_date,
      runtime: r.runtime_min,
      overview: r.overview,
      still: r.still_url,
    },
    unwatchedCount: r.unwatched_aired,
    lastActivity: r.last_activity,
  });

  // Upcoming: the next episodes to air across followed shows, soonest first.
  const { results: upcoming } = await c.env.DB.prepare(
    `SELECT e.id AS episode_id, e.show_id, e.season_number, e.number, e.title AS episode_title, e.air_date,
            s.title AS show_title, s.poster_url
     FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
     WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
       AND e.season_number > 0 AND e.air_date IS NOT NULL AND e.air_date > ?2
     ORDER BY e.air_date, show_title, e.season_number, e.number
     LIMIT 20`
  )
    .bind(uid, today)
    .all();

  const rows = results as any[];
  return c.json({
    watchNext: rows.filter((r) => r.last_activity >= staleBefore).map(toItem),
    stale: rows.filter((r) => r.last_activity < staleBefore).map(toItem),
    upcoming: (upcoming as any[]).map((r) => ({
      episodeId: r.episode_id,
      showId: r.show_id,
      showTitle: r.show_title,
      poster: r.poster_url,
      season: r.season_number,
      number: r.number,
      title: r.episode_title,
      airDate: r.air_date,
    })),
  });
});

// ---------- Library & watchlist ----------

library.get("/library", async (c) => {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  const [showsR, moviesR, favoritesR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT us.show_id AS id, us.state, s.title, s.poster_url AS poster, s.status,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0
            AND e.air_date IS NOT NULL AND e.air_date <= ?2) AS aired,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = us.show_id AND e.season_number > 0) AS total,
         (SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = us.user_id AND e.show_id = us.show_id AND e.season_number > 0) AS watched,
         (SELECT MAX(CASE WHEN ue.last_rewatched_at > ue.watched_at
                          THEN ue.last_rewatched_at ELSE ue.watched_at END)
            FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = us.user_id AND e.show_id = us.show_id) AS last_watched_at
       FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.user_id = ?1 AND us.state != 'watch_later'
       ORDER BY s.title`
    ).bind(uid, today),
    c.env.DB.prepare(
      `SELECT um.movie_id AS id, m.title, m.poster_url AS poster, um.watched_at, um.play_count
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watched'
       ORDER BY um.watched_at DESC`
    ).bind(uid),
    c.env.DB.prepare(
      `SELECT li.target_type AS type, li.target_id AS id, l.id AS list_id,
              COALESCE(s.title, m.title) AS title, COALESCE(s.poster_url, m.poster_url) AS poster
       FROM custom_lists l
       JOIN custom_list_items li ON li.list_id = l.id
       LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
       LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
       WHERE l.user_id = ?1 AND l.kind = 'favorites'
       ORDER BY li.position`
    ).bind(uid),
  ]);

  return c.json({
    shows: (showsR.results as any[]).map((r) => ({ ...r, derivedState: deriveState(r) })),
    movies: moviesR.results,
    favorites: favoritesR.results,
  });
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

// ---------- Mark watched: episode / season / show ----------

library.post("/episodes/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const watchedAt = watchedAtFrom(await c.req.json().catch(() => ({})));
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");

  try {
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
  } catch (e: any) {
    if (String(e.message).includes("FOREIGN KEY")) return c.json({ error: "unknown episode" }, 404);
    throw e;
  }
  return c.json({ ok: true });
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
       SELECT ?1, e.id, ?3 FROM episodes e
       WHERE e.show_id = ?2 AND ${seasonCond}
         AND e.air_date IS NOT NULL AND e.air_date <= ?${seasonNumber == null ? "4" : "5"}
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
       SELECT ?1, e.id, ?3 FROM episodes e
       WHERE e.show_id = ?2 AND e.season_number > 0
         AND (e.season_number < ?4 OR (e.season_number = ?4 AND e.number <= ?5))
         AND e.air_date IS NOT NULL AND e.air_date <= ?6
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
