// Unauthenticated read-only endpoints. Mounted BEFORE the auth middleware —
// only explicitly shared content may ever be served here.
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const pub = new Hono<AppEnv>();

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
