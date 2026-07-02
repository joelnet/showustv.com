import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { requireAuth } from "./lib/session";
import { TmdbError, ensureShow, ensureMovie } from "./lib/tmdb";
import { auth } from "./routes/auth";
import { pub } from "./routes/public";
import { catalog } from "./routes/catalog";
import { library } from "./routes/library";
import { ratings } from "./routes/ratings";
import { lists } from "./routes/lists";
import { profile } from "./routes/profile";
import { importer } from "./routes/import";

const app = new Hono<AppEnv>().basePath("/api");

app.get("/healthz", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true });
});

app.route("/auth", auth);
app.route("/public", pub);

// Everything below requires a session.
app.use("*", requireAuth);
app.route("/", catalog);
app.route("/", library);
app.route("/ratings", ratings);
app.route("/lists", lists);
app.route("/profile", profile);
app.route("/import", importer);

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  if (err instanceof TmdbError) {
    if (err.status === 404) return c.json({ error: "not found on TMDB" }, 404);
    if (err.status === 401) return c.json({ error: "TMDB token missing or invalid — set TMDB_TOKEN" }, 502);
    return c.json({ error: `TMDB upstream error (${err.status})` }, 502);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Nightly (06:00 UTC): re-sync followed shows that are still airing so new
// episodes and air-date changes land before US mornings. Bounded per run.
async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  const staleBefore = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT s.tmdb_id FROM shows s
     WHERE s.status NOT IN ('Ended', 'Canceled')
       AND EXISTS (SELECT 1 FROM user_shows us WHERE us.show_id = s.tmdb_id)
       AND (s.synced_at IS NULL OR s.synced_at < ?1)
     LIMIT 30`
  )
    .bind(staleBefore)
    .all<{ tmdb_id: number }>();

  for (const row of results) {
    try {
      await ensureShow(env, row.tmdb_id, true);
    } catch (e) {
      console.error(`cron: sync failed for show ${row.tmdb_id}`, e);
    }
  }

  // TMDB ToS compliance sweep (api-terms-of-use §1.C): data obtained from the
  // TMDB API may not be cached longer than 6 months, commercial or not. The
  // nightly query above only touches followed, still-airing shows — ended
  // shows, unfollowed catalog rows, and movies would otherwise sit in D1
  // stale forever. Refresh anything untouched for ~5 months to stay
  // comfortably inside the cap. Bounded per run; the backlog drains nightly.
  const capBefore = new Date(Date.now() - 150 * 24 * 3600 * 1000).toISOString();
  const [staleShows, staleMovies] = await env.DB.batch([
    env.DB.prepare("SELECT tmdb_id FROM shows WHERE synced_at < ?1 LIMIT 10").bind(capBefore),
    env.DB.prepare("SELECT tmdb_id FROM movies WHERE synced_at < ?1 LIMIT 10").bind(capBefore),
  ]);
  for (const row of staleShows.results as { tmdb_id: number }[]) {
    try {
      await ensureShow(env, row.tmdb_id, true);
    } catch (e) {
      console.error(`cron: ToS sweep failed for show ${row.tmdb_id}`, e);
    }
  }
  for (const row of staleMovies.results as { tmdb_id: number }[]) {
    try {
      await ensureMovie(env, row.tmdb_id, true);
    } catch (e) {
      console.error(`cron: ToS sweep failed for movie ${row.tmdb_id}`, e);
    }
  }
}

export default { fetch: app.fetch, scheduled };
