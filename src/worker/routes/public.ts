// Unauthenticated read-only endpoints. Mounted BEFORE the auth middleware —
// only explicitly shared content may ever be served here.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";

export const pub = new Hono<AppEnv>();

// Public profile at /u/:username. Private and unknown profiles are
// indistinguishable (404 for both), and only lists that are BOTH pinned to
// the profile AND individually shared are served — a pinned private list
// stays private.
pub.get("/profile/:username", async (c) => {
  const username = c.req.param("username");
  const user = await c.env.DB.prepare(
    "SELECT id, username FROM users WHERE username = ?1 AND profile_public = 1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<{ id: number; username: string }>();
  if (!user) return c.json({ error: "not found" }, 404);

  const [statsR, listsR, postersR] = await c.env.DB.batch([
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
  ]);

  const posters = new Map<number, string[]>();
  for (const r of postersR.results as any[]) {
    const arr = posters.get(r.list_id) ?? [];
    arr.push(r.poster);
    posters.set(r.list_id, arr);
  }
  return c.json({
    username: user.username,
    stats: statsFromRow(statsR.results[0]),
    lists: (listsR.results as any[]).map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
  });
});

pub.get("/lists/:username/:id", async (c) => {
  const username = c.req.param("username");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "not found" }, 404);

  const meta = await c.env.DB.prepare(
    `SELECT l.id, l.name, u.username
     FROM custom_lists l JOIN users u ON u.id = l.user_id
     WHERE l.id = ?1 AND u.username = ?2 AND l.is_shared = 1 AND u.deleted_at IS NULL`
  )
    .bind(id, username)
    .first();
  if (!meta) return c.json({ error: "not found" }, 404);

  const { results: items } = await c.env.DB.prepare(
    `SELECT li.target_type AS type, li.target_id AS id,
            COALESCE(s.title, m.title) AS title, COALESCE(s.poster_url, m.poster_url) AS poster
     FROM custom_list_items li
     LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
     LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
     WHERE li.list_id = ?1 ORDER BY li.position`
  )
    .bind(id)
    .all();

  return c.json({ list: meta, items });
});
