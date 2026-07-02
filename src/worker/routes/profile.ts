// The signed-in user's profile: watch stats, public/private visibility, and
// which of their lists are pinned to it (and in what order). The public,
// unauthenticated view lives in routes/public.ts.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";

export const profile = new Hono<AppEnv>();

profile.get("/", async (c) => {
  const uid = c.get("uid");
  const [userR, statsR, listsR, postersR] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT username, profile_public FROM users WHERE id = ?1").bind(uid),
    statsQuery(c.env.DB, uid),
    c.env.DB.prepare(
      `SELECT l.id, l.name, l.kind, l.is_shared, l.profile_position, COUNT(li.list_id) AS count
       FROM custom_lists l LEFT JOIN custom_list_items li ON li.list_id = l.id
       WHERE l.user_id = ?1 GROUP BY l.id
       ORDER BY (l.profile_position IS NULL), l.profile_position, (l.kind = 'favorites') DESC, l.created_at`
    ).bind(uid),
    // Collage: the first 4 items with a poster per pinned list, trimmed in
    // SQL so large lists don't ship every row to the Worker.
    c.env.DB.prepare(
      `SELECT list_id, poster FROM (
         SELECT li.list_id, COALESCE(s.poster_url, m.poster_url) AS poster,
                ROW_NUMBER() OVER (PARTITION BY li.list_id ORDER BY li.position) AS rn
         FROM custom_list_items li
         JOIN custom_lists l ON l.id = li.list_id AND l.user_id = ?1 AND l.profile_position IS NOT NULL
         LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
         LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
         WHERE COALESCE(s.poster_url, m.poster_url) IS NOT NULL
       ) WHERE rn <= 4 ORDER BY list_id, rn`
    ).bind(uid),
  ]);

  const user = userR.results[0] as { username: string; profile_public: number };
  const posters = new Map<number, string[]>();
  for (const r of postersR.results as any[]) {
    const arr = posters.get(r.list_id) ?? [];
    arr.push(r.poster);
    posters.set(r.list_id, arr);
  }

  const all = listsR.results as any[];
  return c.json({
    username: user.username,
    isPublic: !!user.profile_public,
    stats: statsFromRow(statsR.results[0]),
    lists: all
      .filter((l) => l.profile_position != null)
      .map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
    otherLists: all.filter((l) => l.profile_position == null),
  });
});

profile.put("/visibility", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.public !== "boolean") return c.json({ error: "bad request" }, 400);
  await c.env.DB.prepare("UPDATE users SET profile_public = ?2 WHERE id = ?1")
    .bind(c.get("uid"), body.public ? 1 : 0)
    .run();
  return c.json({ ok: true });
});

// Pin one of your lists to the profile (appended at the end).
profile.post("/lists", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const listId = Number(body.id);
  if (!Number.isInteger(listId) || listId <= 0) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");
  const { meta } = await c.env.DB.prepare(
    `UPDATE custom_lists
     SET profile_position = (SELECT COALESCE(MAX(profile_position) + 1, 0)
                             FROM custom_lists WHERE user_id = ?1)
     WHERE id = ?2 AND user_id = ?1 AND profile_position IS NULL`
  )
    .bind(uid, listId)
    .run();
  if (!meta.changes) {
    const owned = await c.env.DB.prepare("SELECT 1 FROM custom_lists WHERE id = ?1 AND user_id = ?2")
      .bind(listId, uid)
      .first();
    if (!owned) return c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true });
});

profile.delete("/lists/:id", async (c) => {
  const listId = Number(c.req.param("id"));
  await c.env.DB.prepare("UPDATE custom_lists SET profile_position = NULL WHERE id = ?1 AND user_id = ?2")
    .bind(listId, c.get("uid"))
    .run();
  return c.json({ ok: true });
});

// Reorder pinned lists: ids in the desired order, same shape as list-item reordering.
profile.put("/lists/order", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  const uid = c.get("uid");
  // The payload must be exactly a permutation of the caller's currently
  // pinned list ids — a partial, duplicated, or stale set would leave
  // gapped/duplicate positions and nondeterministic ordering.
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM custom_lists WHERE user_id = ?1 AND profile_position IS NOT NULL"
  )
    .bind(uid)
    .all<{ id: number }>();
  const pinned = new Set(results.map((r) => r.id));
  const isPermutation =
    ids.length === pinned.size && new Set(ids).size === ids.length && ids.every((id) => pinned.has(id));
  if (!isPermutation) return c.json({ error: "bad request" }, 400);
  if (!ids.length) return c.json({ ok: true });
  await c.env.DB.batch(
    ids.map((id, i) =>
      c.env.DB.prepare(
        "UPDATE custom_lists SET profile_position = ?3 WHERE id = ?1 AND user_id = ?2 AND profile_position IS NOT NULL"
      ).bind(id, uid, i)
    )
  );
  return c.json({ ok: true });
});
