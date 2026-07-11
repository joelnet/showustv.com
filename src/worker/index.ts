import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import { requireAuth } from "./lib/session";
import { checkAchievements } from "./lib/achievements";
import { TmdbError, ensureShow, ensureMovie } from "./lib/tmdb";
import { isSocialPreviewPath, serveSocialPreview } from "./lib/social-preview";
import { auth } from "./routes/auth";
import { pub } from "./routes/public";
import { catalog, titles } from "./routes/catalog";
import { library } from "./routes/library";
import { ratings } from "./routes/ratings";
import { lists } from "./routes/lists";
import { profile } from "./routes/profile";
import { social } from "./routes/social";
import { comments, commentReads } from "./routes/comments";
import { admin } from "./routes/admin";
import { importer } from "./routes/import";
import { notifications } from "./routes/notifications";

const app = new Hono<AppEnv>().basePath("/api");

// Admin audit log (issue #15): every mutating request — success or failure,
// authed or not — lands in activity_log, so troubleshooting can replay what
// a user did. One middleware instead of per-route calls means new endpoints
// are covered the day they're added. waitUntil keeps the insert off the
// response path; bodies are never logged (passwords, comment text, emails).
app.use("*", async (c, next) => {
  let threw = false;
  try {
    await next();
  } catch (e) {
    threw = true;
    logMutation(c, 500);
    throw e; // app.onError still shapes the client response
  } finally {
    if (!threw) logMutation(c, c.res.status);
  }
});

function logMutation(c: Context<AppEnv>, status: number): void {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const insert = c.env.DB.prepare("INSERT INTO activity_log (user_id, method, route, path, status) VALUES (?1,?2,?3,?4,?5)")
    .bind(c.get("uid") ?? null, method, c.req.routePath ?? "", new URL(c.req.url).pathname, status)
    .run()
    .catch((e) => console.error("activity_log insert failed", e));
  c.executionCtx.waitUntil(insert);

  // Achievements (issue #19) piggyback on the same hook: any successful
  // mutation by a known user may have unlocked something. Runs in the
  // background; a check that loses a race just re-awards idempotently later.
  const uid = c.get("uid");
  if (uid && status < 400 && !new URL(c.req.url).pathname.startsWith("/api/admin/")) {
    c.executionCtx.waitUntil(checkAchievements(c.env, uid).catch((e) => console.error("achievement check failed", e)));
  }
}

app.get("/healthz", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true });
});

app.route("/auth", auth);
app.route("/public", pub);

// Shareable title pages (issue #159): GET /shows/:id, /movies/:id, and
// /episodes/:id accept anonymous requests so shared links open signed-out.
// The router is GET-only and each handler serves public catalog data,
// attaching the viewer's own state solely when a valid session cookie is
// present (optionalAuth per route). Any other method or path on these
// prefixes — every watch/favorite/follow mutation included — falls through
// to requireAuth below.
app.route("/", titles);

// Comment READS (issue #159): listing, load-more, continue-thread, and edit
// history accept anonymous requests so a signed-out visitor on a shared title
// link can read the thread. optionalAuth per route attaches the viewer's own
// myVote/mine only when signed in. Every comment WRITE (post/edit/vote/
// delete) stays in the `comments` router mounted behind requireAuth below.
app.route("/comments", commentReads);

// Everything below requires a session.
app.use("*", requireAuth);
app.route("/", catalog);
app.route("/", library);
app.route("/ratings", ratings);
app.route("/lists", lists);
app.route("/profile", profile);
app.route("/social", social);
app.route("/comments", comments);
app.route("/notifications", notifications);
app.route("/admin", admin);
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
  // Audit-log retention first — 90 days is plenty for troubleshooting, and
  // running before the sync work means a TMDB outage can't skip it.
  try {
    const logBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM activity_log WHERE ts < ?1").bind(logBefore).run();
  } catch (e) {
    console.error("cron: activity_log prune failed", e);
  }

  // Notifications age out on the same 90-day horizon (issue #129) — read or
  // not, nobody scrolls back a season; keeps the per-user scans bounded.
  try {
    const notifBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?1").bind(notifBefore).run();
  } catch (e) {
    console.error("cron: notifications prune failed", e);
  }

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

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // Shareable pages: run_worker_first routes /show/*, /movie/*, /episode/*
    // (issue #211) and /u/* (issue #219) here so the SPA shell can be served
    // with per-title or per-profile OG/Twitter meta. Everything it declines
    // (non-GET, unknown ids, private profiles) falls through to the
    // static-asset server; all other paths are API traffic for the Hono app.
    if (isSocialPreviewPath(new URL(req.url).pathname)) return serveSocialPreview(req, env);
    return app.fetch(req, env, ctx);
  },
  scheduled,
};
