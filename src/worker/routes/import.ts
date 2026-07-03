// TV Time import endpoints. The browser parses the export zip and sends only
// distilled records here:
//   POST /import/resolve          — match TVDB ids / titles to TMDB entries
//   POST /import/resolve-episodes — TVDB episode ids → show/season/number
//   POST /import/shows/:id/episodes — follow + bulk-mark with original watched_at
//   POST /import/movies           — bulk-mark movies watched / watchlisted
// All timestamps are ISO 8601 UTC. Inserts never clobber existing watch
// history or inflate rewatch counts on re-import; the only conflict update
// allowed is promoting a watch_later/watchlist row once watch history lands.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { tmdb, ensureShow, ensureMovie } from "../lib/tmdb";
import { nowIso } from "../lib/dates";

export const importer = new Hono<AppEnv>();

const MAX_RESOLVE_SHOWS = 50;
const MAX_RESOLVE_MOVIES = 25;
const MAX_RESOLVE_EPISODES = 50;
const MAX_EPISODES_PER_CALL = 500;
const MAX_MOVIES_PER_CALL = 25;
const MAX_FAVORITES_PER_CALL = 100;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME_CHARS = 250;

// Reads the JSON body with a byte cap enforced BEFORE parsing so an oversized
// payload is never materialized. Returns null when too large (caller responds
// 413); malformed JSON degrades to {} like the other routes.
async function readJson(c: Context<AppEnv>): Promise<{ body: any } | null> {
  const len = Number(c.req.header("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return null;
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: {} };
  }
}

// Missing/non-array fields → empty; arrays over the cap are REJECTED (null →
// caller responds 400) instead of silently truncated, so the client can never
// mistake a partial result for a complete one.
function capArray(v: unknown, max: number): unknown[] | null {
  if (v == null || !Array.isArray(v)) return [];
  return v.length > max ? null : v;
}

const normTitle = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------- resolution ----------

interface ShowMatch {
  tmdbId: number;
  title: string;
  poster: string | null;
}

// Exact (normalized) title match against TMDB /search/tv. Returns the first
// exact hit; when a disambiguating `year` is supplied, an entry whose
// first_air_date year matches wins, and an ambiguous set (several same-titled
// shows, none matching the year) resolves to nothing rather than guessing.
async function searchTvExact(
  c: Context<AppEnv>,
  query: string,
  target: string,
  year: number | null
): Promise<ShowMatch | null> {
  const res = await tmdb(c.env, "/search/tv", { query, include_adult: "false" }, 86400);
  const exact = (res.results ?? [])
    .slice(0, 10)
    .filter((r: any) => normTitle(r.name ?? "") === target || normTitle(r.original_name ?? "") === target);
  const hit =
    year != null
      ? exact.find((r: any) => (r.first_air_date ?? "").slice(0, 4) === String(year)) ?? (exact.length === 1 ? exact[0] : null)
      : exact[0];
  return hit ? { tmdbId: hit.id, title: hit.name, poster: hit.poster_path ?? null } : null;
}

async function resolveShow(
  c: Context<AppEnv>,
  item: { tvdbId?: unknown; name?: unknown }
): Promise<{ match: ShowMatch | null; method: string | null }> {
  const tvdbId = posInt(item.tvdbId);
  const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_CHARS) : "";

  if (tvdbId != null) {
    // Cheap path: a show someone already ensured carries its TVDB id in D1.
    const row = await c.env.DB.prepare("SELECT tmdb_id, title, poster_url FROM shows WHERE tvdb_id = ?1")
      .bind(tvdbId)
      .first<{ tmdb_id: number; title: string; poster_url: string | null }>();
    if (row) return { match: { tmdbId: row.tmdb_id, title: row.title, poster: row.poster_url }, method: "tvdb" };

    const found = await tmdb(c.env, `/find/${tvdbId}`, { external_source: "tvdb_id" }, 86400);
    const tv = found.tv_results?.[0];
    if (tv) return { match: { tmdbId: tv.id, title: tv.name, poster: tv.poster_path ?? null }, method: "tvdb" };
  }

  if (name) {
    // Name fallback: only accept an exact (normalized) title match — a wrong
    // auto-match silently corrupts a library, so anything fuzzier is reported
    // back as unmatched instead.
    let match = await searchTvExact(c, name, normTitle(name), null);
    // TV Time disambiguates some titles with a trailing "(YYYY)" that TMDB's
    // own title omits ("Foundation (2021)" → "Foundation"); retry on the bare
    // title, using the year to break ties between same-named shows.
    if (!match) {
      const ym = /^(.*?)\s*\((\d{4})\)$/.exec(name);
      if (ym) match = await searchTvExact(c, ym[1].trim(), normTitle(ym[1]), Number(ym[2]));
    }
    if (match) return { match, method: "name" };
  }

  return { match: null, method: null };
}

async function resolveMovie(
  c: Context<AppEnv>,
  item: { name?: unknown; year?: unknown }
): Promise<{ match: ShowMatch | null; method: string | null }> {
  const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_CHARS) : "";
  if (!name) return { match: null, method: null };
  const year = posInt(item.year);

  const params: Record<string, string> = { query: name, include_adult: "false" };
  if (year != null) params.year = String(year);
  const res = await tmdb(c.env, "/search/movie", params, 86400);
  const target = normTitle(name);
  const hit = (res.results ?? [])
    .slice(0, 10)
    .find((r: any) => normTitle(r.title ?? "") === target || normTitle(r.original_title ?? "") === target);
  if (hit) return { match: { tmdbId: hit.id, title: hit.title, poster: hit.poster_path ?? null }, method: "name" };
  return { match: null, method: null };
}

importer.post("/resolve", async (c) => {
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const shows = capArray(rj.body.shows, MAX_RESOLVE_SHOWS);
  const movies = capArray(rj.body.movies, MAX_RESOLVE_MOVIES);
  if (!shows || !movies)
    return c.json({ error: `too many items (max ${MAX_RESOLVE_SHOWS} shows / ${MAX_RESOLVE_MOVIES} movies per call)` }, 400);

  const showResults = [];
  for (const item of shows) {
    try {
      showResults.push(await resolveShow(c, item ?? {}));
    } catch {
      showResults.push({ match: null, method: null, error: true });
    }
  }
  const movieResults = [];
  for (const item of movies) {
    try {
      movieResults.push(await resolveMovie(c, item ?? {}));
    } catch {
      movieResults.push({ match: null, method: null, error: true });
    }
  }
  return c.json({ shows: showResults, movies: movieResults });
});

// TVDB episode ids → { show, season, number } via TMDB /find (cached 24h).
// Used only for old-format exports whose rows lack season/episode numbers.
importer.post("/resolve-episodes", async (c) => {
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const rawIds = capArray(rj.body.ids, MAX_RESOLVE_EPISODES);
  if (!rawIds) return c.json({ error: `too many ids (max ${MAX_RESOLVE_EPISODES} per call)` }, 400);
  const ids: number[] = rawIds.map(posInt).filter((n: number | null): n is number => n != null);

  const results: Record<number, { show: number; season: number; number: number } | null> = {};
  for (const id of ids) {
    try {
      const found = await tmdb(c.env, `/find/${id}`, { external_source: "tvdb_id" }, 86400);
      const ep = found.tv_episode_results?.[0];
      results[id] =
        ep && posInt(ep.show_id) != null && Number.isInteger(ep.season_number) && Number.isInteger(ep.episode_number)
          ? { show: ep.show_id, season: ep.season_number, number: ep.episode_number }
          : null;
    } catch {
      results[id] = null;
    }
  }
  return c.json({ results });
});

// ---------- import ----------

// Follow the show and bulk-mark episodes watched with their original
// timestamps. Episodes are matched by (season, number) against the TMDB
// catalog loaded by ensureShow; anything TMDB doesn't know is reported back.
importer.post("/shows/:id/episodes", async (c) => {
  const id = posInt(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const raw = capArray(rj.body.episodes, MAX_EPISODES_PER_CALL);
  if (!raw) return c.json({ error: `too many episodes (max ${MAX_EPISODES_PER_CALL} per call)` }, 400);

  const episodes: { s: number; e: number; at: string | null }[] = [];
  for (const r of raw as any[]) {
    const s = Number(r?.season);
    const e = Number(r?.number);
    if (!Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e < 1) continue;
    episodes.push({ s, e, at: isoOrNull(r?.watchedAt) });
  }

  const uid = c.get("uid");
  await ensureShow(c.env, id); // TmdbError bubbles to the app-level handler

  const payload = JSON.stringify(episodes);
  // Importing actual watch history promotes a parked (watch_later) show to
  // watching — same semantics as marking an episode watched by hand. A
  // follow-only import leaves any existing state untouched.
  const followSql =
    episodes.length > 0
      ? `INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2)
         ON CONFLICT (user_id, show_id) DO UPDATE
           SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE user_shows.state = 'watch_later'`
      : "INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING";
  const stmts = [
    c.env.DB.prepare(followSql).bind(uid, id),
    c.env.DB.prepare(
      `INSERT INTO user_episodes (user_id, episode_id, watched_at)
       SELECT ?1, ep.id, COALESCE(json_extract(j.value, '$.at'), ?3)
       FROM json_each(?4) j
       JOIN episodes ep ON ep.season_number = json_extract(j.value, '$.s') AND ep.number = json_extract(j.value, '$.e')
       WHERE ep.show_id = ?2
       ON CONFLICT (user_id, episode_id) DO NOTHING`
    ).bind(uid, id, nowIso(), payload),
  ];
  const [, insertR] = await c.env.DB.batch(stmts);

  const { results: notFound } = await c.env.DB.prepare(
    `SELECT json_extract(j.value, '$.s') AS season, json_extract(j.value, '$.e') AS number
     FROM json_each(?1) j
     WHERE NOT EXISTS (
       SELECT 1 FROM episodes ep
       WHERE ep.show_id = ?2 AND ep.season_number = json_extract(j.value, '$.s') AND ep.number = json_extract(j.value, '$.e')
     )`
  )
    .bind(payload, id)
    .all();

  const inserted = insertR.meta.changes ?? 0;
  const matched = episodes.length - notFound.length;
  return c.json({
    ok: true,
    requested: episodes.length,
    matched,
    inserted,
    existing: matched - inserted,
    notFound,
  });
});

// Import TV Time favorites (issue #21). Favorites are a system-kind list,
// created once here so the concurrent per-show import can't race two into
// existence. Adds are idempotent — re-running never duplicates an entry.
importer.post("/favorites", async (c) => {
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const raw = capArray(rj.body.shows, MAX_FAVORITES_PER_CALL);
  if (!raw) return c.json({ error: `too many favorites (max ${MAX_FAVORITES_PER_CALL} per call)` }, 400);
  const ids = (raw as unknown[]).map(posInt).filter((n): n is number => n != null);
  const uid = c.get("uid");

  const existingList = await c.env.DB.prepare(
    "SELECT id FROM custom_lists WHERE user_id = ?1 AND kind = 'favorites'"
  )
    .bind(uid)
    .first<{ id: number }>();
  const listId =
    existingList?.id ??
    (await c.env.DB.prepare(
      "INSERT INTO custom_lists (user_id, name, kind) VALUES (?1, 'Favorites', 'favorites') RETURNING id"
    )
      .bind(uid)
      .first<{ id: number }>())!.id;

  let added = 0;
  let existing = 0;
  const failed: number[] = [];
  for (const id of ids) {
    try {
      await ensureShow(c.env, id); // so the favorite renders with a title/poster
      const res = await c.env.DB.prepare(
        `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
         SELECT ?1, 'show', ?2, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
         ON CONFLICT (list_id, target_type, target_id) DO NOTHING`
      )
        .bind(listId, id)
        .run();
      if ((res.meta.changes ?? 0) > 0) added++;
      else existing++;
    } catch {
      failed.push(id);
    }
  }
  return c.json({ ok: true, added, existing, failed });
});

// Import TV Time archived shows (issue #29). An archived show maps to our
// "stopped" state ("Stopped Watching"). Runs after the per-show episode import
// so it overrides the 'watching' state that importing watch history sets —
// the export's archived flag is the user's final word on the show.
importer.post("/shows/archived", async (c) => {
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const raw = capArray(rj.body.shows, MAX_FAVORITES_PER_CALL);
  if (!raw) return c.json({ error: `too many shows (max ${MAX_FAVORITES_PER_CALL} per call)` }, 400);
  const ids = (raw as unknown[]).map(posInt).filter((n): n is number => n != null);
  const uid = c.get("uid");

  let updated = 0;
  const failed: number[] = [];
  for (const id of ids) {
    try {
      await ensureShow(c.env, id); // so the stopped show renders with a title/poster
      await c.env.DB.prepare(
        `INSERT INTO user_shows (user_id, show_id, state) VALUES (?1, ?2, 'stopped')
         ON CONFLICT (user_id, show_id) DO UPDATE
           SET state = 'stopped', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
        .bind(uid, id)
        .run();
      updated++;
    } catch {
      failed.push(id);
    }
  }
  return c.json({ ok: true, updated, failed });
});

importer.post("/movies", async (c) => {
  const rj = await readJson(c);
  if (!rj) return c.json({ error: "payload too large" }, 413);
  const raw = capArray(rj.body.movies, MAX_MOVIES_PER_CALL);
  if (!raw) return c.json({ error: `too many movies (max ${MAX_MOVIES_PER_CALL} per call)` }, 400);
  const uid = c.get("uid");

  let inserted = 0;
  let existing = 0;
  const failed: number[] = [];
  for (const r of raw as any[]) {
    const tmdbId = posInt(r?.tmdbId);
    if (!tmdbId) continue;
    const watchlist = r?.watchlist === true;
    try {
      await ensureMovie(c.env, tmdbId);
      // A watched import promotes an existing watchlist row (play_count 0 → 1)
      // but never touches a row that is already watched — original watched_at
      // and play_count survive re-imports untouched.
      const res = watchlist
        ? await c.env.DB.prepare(
            `INSERT INTO user_movies (user_id, movie_id, state, watched_at, play_count) VALUES (?1, ?2, 'watchlist', NULL, 0)
             ON CONFLICT (user_id, movie_id) DO NOTHING`
          )
            .bind(uid, tmdbId)
            .run()
        : await c.env.DB.prepare(
            `INSERT INTO user_movies (user_id, movie_id, state, watched_at, play_count) VALUES (?1, ?2, 'watched', ?3, 1)
             ON CONFLICT (user_id, movie_id) DO UPDATE
               SET state = 'watched', watched_at = excluded.watched_at, play_count = 1
               WHERE user_movies.state = 'watchlist'`
          )
            .bind(uid, tmdbId, isoOrNull(r?.watchedAt) ?? nowIso())
            .run();
      if ((res.meta.changes ?? 0) > 0) inserted++;
      else existing++;
    } catch {
      failed.push(tmdbId);
    }
  }
  return c.json({ ok: true, inserted, existing, failed });
});
