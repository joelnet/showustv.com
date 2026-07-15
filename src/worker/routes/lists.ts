import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ensureShow, ensureMovie } from "../lib/tmdb";
import { notifyFollowersOfFavorite } from "../lib/notifications";
import { ownerListCommentsStmt, collectOwnerComments } from "../lib/list-comments";

export const lists = new Hono<AppEnv>();

async function ownList(c: any, listId: number): Promise<boolean> {
  const row = await c.env.DB.prepare("SELECT 1 FROM custom_lists WHERE id = ?1 AND user_id = ?2")
    .bind(listId, c.get("uid"))
    .first();
  return !!row;
}

lists.get("/", async (c) => {
  const uid = c.get("uid");
  // Optional membership flag for the "Add to list" picker (issue #318): when a
  // title (?type=show|movie&id=…) is passed, each list also reports whether it
  // already contains that title, so the picker can render a checked/unchecked
  // checkbox per list. Without the params this is the plain Lists-page listing.
  const mType = c.req.query("type");
  const mId = Number(c.req.query("id"));
  const withMembership = (mType === "show" || mType === "movie") && Number.isInteger(mId) && mId > 0;

  const listsStmt = withMembership
    ? c.env.DB.prepare(
        `SELECT l.id, l.name, l.kind, l.is_shared, COUNT(li.list_id) AS count,
                EXISTS(SELECT 1 FROM custom_list_items m
                       WHERE m.list_id = l.id AND m.target_type = ?2 AND m.target_id = ?3) AS has_item
         FROM custom_lists l LEFT JOIN custom_list_items li ON li.list_id = l.id
         WHERE l.user_id = ?1 GROUP BY l.id ORDER BY (l.kind = 'favorites') DESC, l.created_at`
      ).bind(uid, mType, mId)
    : c.env.DB.prepare(
        `SELECT l.id, l.name, l.kind, l.is_shared, COUNT(li.list_id) AS count
         FROM custom_lists l LEFT JOIN custom_list_items li ON li.list_id = l.id
         WHERE l.user_id = ?1 GROUP BY l.id ORDER BY (l.kind = 'favorites') DESC, l.created_at`
      ).bind(uid);

  const [listsR, itemsR] = await c.env.DB.batch([
    listsStmt,
    c.env.DB.prepare(
      `SELECT li.list_id, COALESCE(s.poster_url, m.poster_url) AS poster
       FROM custom_list_items li
       JOIN custom_lists l ON l.id = li.list_id AND l.user_id = ?1
       LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
       LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
       ORDER BY li.list_id, li.position`
    ).bind(uid),
  ]);

  const posters = new Map<number, string[]>();
  for (const r of itemsR.results as any[]) {
    const arr = posters.get(r.list_id) ?? [];
    if (arr.length < 4 && r.poster) arr.push(r.poster);
    posters.set(r.list_id, arr);
  }
  return c.json({
    lists: (listsR.results as any[]).map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
  });
});

lists.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 60) return c.json({ error: "bad name" }, 400);
  const row = await c.env.DB.prepare("INSERT INTO custom_lists (user_id, name) VALUES (?1, ?2) RETURNING id")
    .bind(c.get("uid"), name)
    .first<{ id: number }>();
  return c.json({ id: row!.id, name });
});

lists.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  const uid = c.get("uid");
  const [metaR, itemsR, cmtsR] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT id, name, kind, is_shared, profile_position, preamble, comments_enabled FROM custom_lists WHERE id = ?1"
    ).bind(id),
    // `overview` is served so the owner's cards read like the visitor's shared
    // view (issue #325); `genres_json`/`original_language` still feed the
    // favorites Shows/Movies/Anime split (issue #103).
    c.env.DB.prepare(
      `SELECT li.target_type AS type, li.target_id AS id, li.position,
              COALESCE(s.title, m.title) AS title, COALESCE(s.poster_url, m.poster_url) AS poster,
              COALESCE(s.overview, m.overview) AS overview,
              COALESCE(s.genres_json, m.genres_json) AS genres_json,
              COALESCE(s.original_language, m.original_language) AS original_language
       FROM custom_list_items li
       LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
       LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
       WHERE li.list_id = ?1 ORDER BY li.position`
    ).bind(id),
    // The owner's own top-level comment per item (issue #322), the same query
    // the public share uses (shared in lib/list-comments so they can't drift).
    // The author is always the list owner (this route is owner-only), so
    // there's no shadow-ban gating to do: an owner always sees their own.
    ownerListCommentsStmt(c.env.DB, id, uid),
  ]);
  const ownerComments = collectOwnerComments(cmtsR.results as any[]);
  return c.json({
    list: metaR.results[0],
    items: (itemsR.results as any[]).map((it) => ({
      ...it,
      ownerComment: ownerComments.get(`${it.type}:${it.id}`) ?? null,
    })),
  });
});

lists.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 60) return c.json({ error: "bad name" }, 400);
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("UPDATE custom_lists SET name = ?2 WHERE id = ?1").bind(id, name).run();
  return c.json({ ok: true });
});

// Optional preamble (issue #94): a short note the owner writes about the list.
// Separate from rename so it can be edited on its own; empty trims to NULL.
lists.put("/:id/preamble", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const preamble = body.preamble == null ? null : String(body.preamble).trim().slice(0, 2000) || null;
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("UPDATE custom_lists SET preamble = ?2 WHERE id = ?1").bind(id, preamble).run();
  return c.json({ ok: true });
});

// Per-list comments on/off toggle, owner-controlled (issue #98). Comments only
// surface on shared lists; the flag is stored regardless so it's remembered.
lists.put("/:id/comments", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const enabled = body.enabled ? 1 : 0;
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("UPDATE custom_lists SET comments_enabled = ?2 WHERE id = ?1").bind(id, enabled).run();
  return c.json({ ok: true });
});

lists.put("/:id/visibility", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.public !== "boolean") return c.json({ error: "bad request" }, 400);
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  // Making a list private also unpins it from the profile (issue #33): a
  // private list can never appear there, so the two states stay consistent
  // even if the client forgets to warn.
  await c.env.DB.prepare(
    body.public
      ? "UPDATE custom_lists SET is_shared = 1 WHERE id = ?1"
      : "UPDATE custom_lists SET is_shared = 0, profile_position = NULL WHERE id = ?1"
  )
    .bind(id)
    .run();
  return c.json({ ok: true });
});

lists.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM custom_lists WHERE id = ?1").bind(id).run();
  return c.json({ ok: true });
});

lists.post("/:id/items", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const type = String(body.type ?? "");
  const targetId = Number(body.id);
  if (!["show", "movie"].includes(type) || !Number.isInteger(targetId) || targetId <= 0)
    return c.json({ error: "bad item" }, 400);
  // Alone among these routes, the list's KIND matters: the Favorites system
  // list sits in the "Add to list…" picker too, and adding to it there IS
  // favoriting — it must notify exactly like the heart endpoints.
  const list = await c.env.DB.prepare("SELECT kind FROM custom_lists WHERE id = ?1 AND user_id = ?2")
    .bind(id, c.get("uid"))
    .first<{ kind: string }>();
  if (!list) return c.json({ error: "not found" }, 404);

  if (type === "show") await ensureShow(c.env, targetId);
  else await ensureMovie(c.env, targetId);

  // RETURNING detects the transition INTO the list (the ON CONFLICT no-op
  // returns nothing), so a re-add never re-notifies.
  const created = await c.env.DB.prepare(
    `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
     SELECT ?1, ?2, ?3, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
     ON CONFLICT (list_id, target_type, target_id) DO NOTHING
     RETURNING list_id`
  )
    .bind(id, type, targetId)
    .first();
  // Notify followers (issue #266), off the response path — same hook as the
  // heart routes in library.ts; the fan-out skips hidden shows (#260) and
  // dedupes per actor/title per day.
  if (created && list.kind === "favorites") {
    c.executionCtx.waitUntil(
      notifyFollowersOfFavorite(c.env, c.get("uid"), type as "show" | "movie", targetId).catch((e) =>
        console.error("notify failed", e)
      )
    );
  }
  return c.json({ ok: true });
});

lists.delete("/:id/items/:type/:targetId", async (c) => {
  const id = Number(c.req.param("id"));
  const type = c.req.param("type");
  const targetId = Number(c.req.param("targetId"));
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare(
    "DELETE FROM custom_list_items WHERE list_id = ?1 AND target_type = ?2 AND target_id = ?3"
  )
    .bind(id, type, targetId)
    .run();
  return c.json({ ok: true });
});

lists.put("/:id/order", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const items: any[] = Array.isArray(body.items) ? body.items : [];
  if (!(await ownList(c, id))) return c.json({ error: "not found" }, 404);
  if (!items.length) return c.json({ ok: true });
  await c.env.DB.batch(
    items.map((it, i) =>
      c.env.DB.prepare(
        "UPDATE custom_list_items SET position = ?4 WHERE list_id = ?1 AND target_type = ?2 AND target_id = ?3"
      ).bind(id, String(it.type), Number(it.id), i)
    )
  );
  return c.json({ ok: true });
});
