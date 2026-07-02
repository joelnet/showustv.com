// TMDB client. Read path: Cache API (edge, free) → origin. Durable metadata
// for followed shows lands in D1 via ensureShow/ensureMovie, refreshed by the
// nightly cron. Never store TMDB images — poster/backdrop are path fragments
// the client resolves against image.tmdb.org.
//
// Note: the Cache API is a no-op on *.workers.dev — caching only kicks in on
// the custom domain. TMDB's ~40 req/s limit makes that acceptable meanwhile.

import type { Env } from "../env";
import { nowIso } from "./dates";

export class TmdbError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function tmdb(env: Env, path: string, params: Record<string, string> = {}, ttlSec = 86400): Promise<any> {
  const url = new URL(env.TMDB_API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const cacheKey = new Request(url.toString());

  const cached = ttlSec > 0 ? await caches.default.match(cacheKey) : undefined;
  if (cached) return cached.json();

  // v4 read tokens are JWTs (Bearer header); v3 keys go in the query string.
  const headers: Record<string, string> = { accept: "application/json" };
  if (env.TMDB_TOKEN?.startsWith("eyJ")) headers.authorization = `Bearer ${env.TMDB_TOKEN}`;
  else url.searchParams.set("api_key", env.TMDB_TOKEN ?? "");

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new TmdbError(res.status, `TMDB ${res.status} for ${path}`);

  if (ttlSec > 0) {
    const toCache = new Response(res.clone().body, res);
    toCache.headers.set("Cache-Control", `public, max-age=${ttlSec}`);
    await caches.default.put(cacheKey, toCache);
  }
  return res.json();
}

const FRESH_MS = 7 * 24 * 3600 * 1000; // on-demand refetch threshold (cron handles returning shows nightly)
const SEASONS_PER_CALL = 20; // TMDB append_to_response limit
const EPISODE_ROWS_PER_STMT = 9; // 10 params/row; D1 caps at 100 params/statement

export async function ensureShow(env: Env, tmdbId: number, force = false): Promise<void> {
  if (!force) {
    const row = await env.DB.prepare("SELECT synced_at FROM shows WHERE tmdb_id = ?1").bind(tmdbId).first<{
      synced_at: string | null;
    }>();
    if (row?.synced_at && Date.now() - Date.parse(row.synced_at) < FRESH_MS) return;
  }

  const base = await tmdb(env, `/tv/${tmdbId}`, { append_to_response: "external_ids" }, 600);
  const seasonNumbers: number[] = (base.seasons ?? []).map((s: any) => s.season_number);

  // Pull all season details, batched via append_to_response.
  const seasonData: Record<number, any> = {};
  for (let i = 0; i < seasonNumbers.length; i += SEASONS_PER_CALL) {
    const chunk = seasonNumbers.slice(i, i + SEASONS_PER_CALL);
    const res = await tmdb(env, `/tv/${tmdbId}`, { append_to_response: chunk.map((n) => `season/${n}`).join(",") }, 600);
    for (const n of chunk) if (res[`season/${n}`]) seasonData[n] = res[`season/${n}`];
  }

  const incomingEpisodeIds = Object.values(seasonData).flatMap((sd: any) => (sd.episodes ?? []).map((e: any) => e.id));

  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    env.DB.prepare(
      `INSERT INTO shows (tmdb_id, tvdb_id, title, status, first_air_date, poster_url, backdrop_url, overview, genres_json, synced_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT (tmdb_id) DO UPDATE SET
         tvdb_id=excluded.tvdb_id, title=excluded.title, status=excluded.status,
         first_air_date=excluded.first_air_date, poster_url=excluded.poster_url,
         backdrop_url=excluded.backdrop_url, overview=excluded.overview,
         genres_json=excluded.genres_json, synced_at=excluded.synced_at`
    ).bind(
      tmdbId,
      base.external_ids?.tvdb_id ?? null,
      base.name,
      base.status ?? "unknown",
      base.first_air_date || null,
      base.poster_path ?? null,
      base.backdrop_path ?? null,
      base.overview ?? null,
      JSON.stringify((base.genres ?? []).map((g: any) => g.name)),
      nowIso()
    )
  );

  // TMDB sometimes restructures a show: a season keeps its number but gets a
  // new TMDB id (or disappears). The double ON CONFLICT lets either identity
  // win without aborting the sync — critical for the unattended nightly cron.
  for (const s of base.seasons ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO seasons (id, show_id, number, name) VALUES (?1,?2,?3,?4)
         ON CONFLICT (id) DO UPDATE SET name=excluded.name
         ON CONFLICT (show_id, number) DO UPDATE SET name=excluded.name`
      ).bind(s.id, tmdbId, s.season_number, s.name ?? null)
    );
  }

  // Drop seasons/episodes TMDB no longer lists (cascades clean up watch rows
  // only for content that genuinely ceased to exist).
  stmts.push(
    env.DB.prepare("DELETE FROM seasons WHERE show_id = ?1 AND number NOT IN (SELECT value FROM json_each(?2))").bind(
      tmdbId,
      JSON.stringify(seasonNumbers)
    )
  );
  stmts.push(
    env.DB.prepare("DELETE FROM episodes WHERE show_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))").bind(
      tmdbId,
      JSON.stringify(incomingEpisodeIds)
    )
  );

  await env.DB.batch(stmts);

  // Episode rows attach to whatever season row actually survived above, so
  // resolve season ids from the DB — not from the TMDB payload. (Season
  // details appended via append_to_response omit their own `id` anyway.)
  const seasonRows = await env.DB.prepare("SELECT id, number FROM seasons WHERE show_id = ?1").bind(tmdbId).all<{
    id: number;
    number: number;
  }>();
  const seasonIdByNumber = new Map(seasonRows.results.map((r) => [r.number, r.id]));

  const episodes = Object.entries(seasonData).flatMap(([num, sd]: [string, any]) =>
    (sd.episodes ?? []).map((e: any) => [
      e.id,
      seasonIdByNumber.get(Number(num)),
      tmdbId,
      e.season_number,
      e.episode_number,
      e.name ?? null,
      e.air_date || null,
      e.runtime ?? null,
      e.overview ?? null,
      e.still_path ?? null,
    ])
  );

  const epStmts: D1PreparedStatement[] = [];
  for (let i = 0; i < episodes.length; i += EPISODE_ROWS_PER_STMT) {
    const chunk = episodes.slice(i, i + EPISODE_ROWS_PER_STMT);
    const placeholders = chunk.map((_, r) => `(${Array.from({ length: 10 }, (_, c) => `?${r * 10 + c + 1}`).join(",")})`);
    epStmts.push(
      env.DB.prepare(
        `INSERT INTO episodes (id, season_id, show_id, season_number, number, title, air_date, runtime_min, overview, still_url)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (id) DO UPDATE SET
           season_id=excluded.season_id, season_number=excluded.season_number, number=excluded.number,
           title=excluded.title, air_date=excluded.air_date, runtime_min=excluded.runtime_min,
           overview=excluded.overview, still_url=excluded.still_url`
      ).bind(...chunk.flat())
    );
  }
  if (epStmts.length) await env.DB.batch(epStmts);
}

export async function ensureMovie(env: Env, tmdbId: number, force = false): Promise<void> {
  if (!force) {
    const row = await env.DB.prepare("SELECT synced_at FROM movies WHERE tmdb_id = ?1").bind(tmdbId).first<{
      synced_at: string | null;
    }>();
    if (row?.synced_at && Date.now() - Date.parse(row.synced_at) < FRESH_MS) return;
  }
  const m = await tmdb(env, `/movie/${tmdbId}`, {}, 600);
  await env.DB.prepare(
    `INSERT INTO movies (tmdb_id, title, release_date, runtime_min, poster_url, overview, genres_json, synced_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       title=excluded.title, release_date=excluded.release_date, runtime_min=excluded.runtime_min,
       poster_url=excluded.poster_url, overview=excluded.overview, genres_json=excluded.genres_json,
       synced_at=excluded.synced_at`
  )
    .bind(
      tmdbId,
      m.title,
      m.release_date || null,
      m.runtime ?? null,
      m.poster_path ?? null,
      m.overview ?? null,
      JSON.stringify((m.genres ?? []).map((g: any) => g.name)),
      nowIso()
    )
    .run();
}

// US flatrate providers for the where-to-watch strip. Requires JustWatch
// attribution wherever rendered.
export async function watchProviders(env: Env, kind: "tv" | "movie", tmdbId: number): Promise<any[]> {
  try {
    const data = await tmdb(env, `/${kind}/${tmdbId}/watch/providers`, {}, 86400);
    return (data.results?.US?.flatrate ?? []).map((p: any) => ({
      name: p.provider_name,
      logo: p.logo_path,
    }));
  } catch {
    return [];
  }
}
