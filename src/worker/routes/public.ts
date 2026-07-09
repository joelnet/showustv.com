// Unauthenticated read-only endpoints. Mounted BEFORE the auth middleware —
// only explicitly shared content may ever be served here.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";
import { readSession } from "../lib/session";

export const pub = new Hono<AppEnv>();

// Public profile at /u/:username. A private profile answers with an
// Instagram-style teaser — the canonical username and `private: true`,
// nothing else — so the page can say "this profile is private" instead of
// pretending the person doesn't exist. Only a genuinely unknown (or deleted)
// username 404s. The owner is the one viewer who still gets their full
// profile here (nobody else does — followers included, since profile privacy
// hides the page content from everyone but the owner). Of the lists, only
// those BOTH pinned to the profile AND individually shared are served — a
// pinned private list stays private.
pub.get("/profile/:username", async (c) => {
  const username = c.req.param("username");
  const user = await c.env.DB.prepare(
    "SELECT id, username, profile_public, shadow_banned FROM users WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<{ id: number; username: string; profile_public: number; shadow_banned: number }>();
  if (!user) return c.json({ error: "not found" }, 404);

  const viewer = await readSession(c);

  // The teaser (issue #158): confirms the profile exists and is private, and
  // must never carry the private content — no stats, lists, achievements,
  // comments, or counts.
  if (!user.profile_public && viewer?.u !== user.id) {
    return c.json({ username: user.username, private: true });
  }

  const [statsR, listsR, postersR, commentsR, achR] = await c.env.DB.batch([
    statsQuery(c.env.DB, user.id),
    c.env.DB.prepare(
      `SELECT l.id, l.name, COUNT(li.list_id) AS count
       FROM custom_lists l LEFT JOIN custom_list_items li ON li.list_id = l.id
       WHERE l.user_id = ?1 AND l.profile_position IS NOT NULL AND l.is_shared = 1
       GROUP BY l.id ORDER BY l.profile_position`
    ).bind(user.id),
    // Collage: the first 4 items with a poster per list, trimmed in SQL so
    // large lists don't ship every row to the Worker.
    c.env.DB.prepare(
      `SELECT list_id, poster FROM (
         SELECT li.list_id, COALESCE(s.poster_url, m.poster_url) AS poster,
                ROW_NUMBER() OVER (PARTITION BY li.list_id ORDER BY li.position) AS rn
         FROM custom_list_items li
         JOIN custom_lists l ON l.id = li.list_id
           AND l.user_id = ?1 AND l.profile_position IS NOT NULL AND l.is_shared = 1
         LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
         LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
         WHERE COALESCE(s.poster_url, m.poster_url) IS NOT NULL
       ) WHERE rn <= 4 ORDER BY list_id, rn`
    ).bind(user.id),
    // Comment activity (issue #16): which shows this user is talking about.
    // Episode comments surface their show's title — that's the conversation
    // a visitor cares about. Deleted comments never appear, and rows whose
    // catalog target vanished are dropped here, not client-side.
    c.env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.target_type, c.target_id,
              COALESCE(s.title, m.title, es.title) AS title,
              e.season_number AS season, e.number AS episode, e.title AS episode_title
       FROM comments c
       LEFT JOIN shows s ON c.target_type = 'show' AND s.tmdb_id = c.target_id
       LEFT JOIN movies m ON c.target_type = 'movie' AND m.tmdb_id = c.target_id
       LEFT JOIN episodes e ON c.target_type = 'episode' AND e.id = c.target_id
       LEFT JOIN shows es ON es.tmdb_id = e.show_id
       WHERE c.user_id = ?1 AND c.deleted_at IS NULL
         AND COALESCE(s.title, m.title, es.title) IS NOT NULL
       ORDER BY c.created_at DESC LIMIT 15`
    ).bind(user.id),
    c.env.DB.prepare("SELECT achievement_id FROM user_achievements WHERE user_id = ?1 ORDER BY unlocked_at").bind(user.id),
  ]);

  // Comment bodies are a signed-in surface (thread pages sit behind auth,
  // and episode snippets are spoiler-prone) — anonymous visitors get the
  // conversation metadata only: title, episode slate, when.
  const signedIn = !!viewer;
  // Shadow ban (issue #18): the banned user still sees their own
  // conversations here; everyone else sees none — same invisibility their
  // comments get on thread pages, so the profile can't out the ban.
  const hideComments = !!user.shadow_banned && viewer?.u !== user.id;

  const posters = new Map<number, string[]>();
  for (const r of postersR.results as any[]) {
    const arr = posters.get(r.list_id) ?? [];
    arr.push(r.poster);
    posters.set(r.list_id, arr);
  }
  // The owner's preview of their own private profile is personal content on
  // a public, viewer-varying URL — no-store keeps it out of the service
  // worker's API cache (sw.js honors this), so it can't be replayed to a
  // later, unauthenticated visitor on the same browser.
  if (!user.profile_public) c.header("Cache-Control", "no-store");
  return c.json({
    username: user.username,
    // Only ever true for the owner previewing their own private profile —
    // every other viewer of a private profile got the teaser above.
    private: !user.profile_public,
    stats: statsFromRow(statsR.results[0]),
    lists: (listsR.results as any[]).map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
    achievements: (achR.results as any[]).map((r) => r.achievement_id),
    comments: (hideComments ? [] : (commentsR.results as any[])).map((r) => ({
      // Snippet only — profiles tease the conversation, the thread holds it.
      body: signedIn ? (r.body.length > 240 ? r.body.slice(0, 239) + "…" : r.body) : null,
      createdAt: r.created_at,
      target: {
        type: r.target_type,
        id: r.target_id,
        title: r.title,
        season: r.season,
        episode: r.episode,
        episodeTitle: r.episode_title,
      },
    })),
  });
});

pub.get("/lists/:username/:id", async (c) => {
  const username = c.req.param("username");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "not found" }, 404);

  const meta = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.preamble, l.comments_enabled, u.username
     FROM custom_lists l JOIN users u ON u.id = l.user_id
     WHERE l.id = ?1 AND u.username = ?2 AND l.is_shared = 1 AND u.deleted_at IS NULL`
  )
    .bind(id, username)
    .first();
  if (!meta) return c.json({ error: "not found" }, 404);

  const { results: items } = await c.env.DB.prepare(
    `SELECT li.target_type AS type, li.target_id AS id,
            COALESCE(s.title, m.title) AS title, COALESCE(s.poster_url, m.poster_url) AS poster,
            COALESCE(s.overview, m.overview) AS overview
     FROM custom_list_items li
     LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
     LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
     WHERE li.list_id = ?1 ORDER BY li.position`
  )
    .bind(id)
    .all();

  return c.json({
    list: {
      id: meta.id,
      name: meta.name,
      preamble: meta.preamble ?? null,
      username: meta.username,
      commentsEnabled: !!meta.comments_enabled,
    },
    items,
  });
});
