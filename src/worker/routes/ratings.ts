import { Hono } from "hono";
import type { AppEnv } from "../env";
import { EMOJI_REACTIONS } from "../../shared/constants";

export const ratings = new Hono<AppEnv>();

const TARGET_TYPES = ["show", "movie", "episode"];

ratings.put("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const targetType = String(body.target_type ?? "");
  const targetId = Number(body.target_id);
  const score = body.score == null ? null : Number(body.score);
  const emoji = body.emoji == null ? null : String(body.emoji);

  if (!TARGET_TYPES.includes(targetType) || !Number.isInteger(targetId) || targetId <= 0)
    return c.json({ error: "bad target" }, 400);
  if (score != null && (!Number.isInteger(score) || score < 1 || score > 10))
    return c.json({ error: "score must be 1–10" }, 400);
  if (emoji != null && !(EMOJI_REACTIONS as readonly string[]).includes(emoji))
    return c.json({ error: "unknown reaction" }, 400);
  if (score == null && emoji == null) return c.json({ error: "nothing to save" }, 400);

  // Partial upsert: only the provided field changes, the other survives.
  await c.env.DB.prepare(
    `INSERT INTO ratings (user_id, target_type, target_id, score, emoji_reaction) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET
       score = COALESCE(excluded.score, ratings.score),
       emoji_reaction = COALESCE(excluded.emoji_reaction, ratings.emoji_reaction)`
  )
    .bind(c.get("uid"), targetType, targetId, score, emoji)
    .run();
  return c.json({ ok: true });
});

ratings.delete("/:type/:id", async (c) => {
  const type = c.req.param("type");
  const id = Number(c.req.param("id"));
  if (!TARGET_TYPES.includes(type) || !Number.isInteger(id)) return c.json({ error: "bad target" }, 400);
  await c.env.DB.prepare("DELETE FROM ratings WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3")
    .bind(c.get("uid"), type, id)
    .run();
  return c.json({ ok: true });
});

// Clear ONLY the star score. The star widget's × unsets the
// rating, but a whole-row DELETE would also drop the separate emoji reaction,
// any review text, and reset created_at — so this nulls the score in place.
// Runs as one atomic batch: if nothing else is on the row, drop it entirely so
// no all-null rating lingers; otherwise keep the row (emoji/review/created_at
// intact) with the score cleared.
ratings.delete("/:type/:id/score", async (c) => {
  const type = c.req.param("type");
  const id = Number(c.req.param("id"));
  if (!TARGET_TYPES.includes(type) || !Number.isInteger(id) || id <= 0)
    return c.json({ error: "bad target" }, 400);
  const uid = c.get("uid");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM ratings WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3
         AND emoji_reaction IS NULL AND review_text IS NULL`
    ).bind(uid, type, id),
    c.env.DB.prepare(
      "UPDATE ratings SET score = NULL WHERE user_id = ?1 AND target_type = ?2 AND target_id = ?3"
    ).bind(uid, type, id),
  ]);
  return c.json({ ok: true });
});
