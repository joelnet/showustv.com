// The signed-in user's profile: watch stats, public/private visibility, and
// which of their lists are pinned to it (and in what order). The public,
// unauthenticated view lives in routes/public.ts.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";
import { sendEmail, sha256Hex } from "../lib/email";
import { nowIso } from "../lib/dates";

export const profile = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESEND_GAP_MS = 60_000;

profile.get("/", async (c) => {
  const uid = c.get("uid");
  const [userR, statsR, listsR, postersR, pendingR, achR] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT username, profile_public, email, email_verified_at FROM users WHERE id = ?1").bind(uid),
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
    c.env.DB.prepare("SELECT email, expires_at FROM email_verifications WHERE user_id = ?1").bind(uid),
    c.env.DB.prepare("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?1 ORDER BY unlocked_at").bind(uid),
  ]);

  const user = userR.results[0] as {
    username: string;
    profile_public: number;
    email: string | null;
    email_verified_at: string | null;
  };
  const pending = pendingR.results[0] as { email: string; expires_at: string } | undefined;
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
    email: user.email,
    emailVerified: !!user.email_verified_at,
    pendingEmail: pending && pending.expires_at > nowIso() ? pending.email : null,
    achievements: (achR.results as any[]).map((r) => ({ id: r.achievement_id, unlockedAt: r.unlocked_at })),
    stats: statsFromRow(statsR.results[0]),
    lists: all
      .filter((l) => l.profile_position != null)
      .map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
    otherLists: all.filter((l) => l.profile_position == null),
  });
});

// Start (or restart) email verification: store the pending address with a
// fresh token and mail the link. users.email only changes when the token is
// clicked (routes/auth.ts), so a typo can't dislodge a verified address.
profile.post("/email", async (c) => {
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: "That doesn't look like an email address" }, 400);

  // Verified-email uniqueness is enforced at claim time too (0001 UNIQUE),
  // but failing fast here beats a dead link in someone's inbox.
  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?1 AND id != ?2").bind(email, uid).first();
  if (taken) return c.json({ error: "That email is already in use" }, 409);

  const prev = await c.env.DB.prepare("SELECT sent_at FROM email_verifications WHERE user_id = ?1")
    .bind(uid)
    .first<{ sent_at: string }>();
  if (prev && Date.now() - Date.parse(prev.sent_at) < RESEND_GAP_MS)
    return c.json({ error: "Verification email just sent — give it a minute" }, 429);

  // The raw token exists only in the email; the DB keeps its digest. The
  // link lands on the SPA confirm page — verification is consumed by an
  // explicit POST there, never by fetching the link (mail scanners prefetch
  // GET links, which must not verify anything).
  const token = crypto.randomUUID().replace(/-/g, "");
  await c.env.DB.prepare(
    `INSERT INTO email_verifications (user_id, email, token, sent_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id) DO UPDATE SET
       email = excluded.email, token = excluded.token, sent_at = excluded.sent_at, expires_at = excluded.expires_at`
  )
    .bind(uid, email, await sha256Hex(token), nowIso(), new Date(Date.now() + VERIFY_TTL_MS).toISOString())
    .run();

  const link = `${new URL(c.req.url).origin}/verify-email?token=${token}`;
  const sent = await sendEmail(
    c.env,
    email,
    "Verify your email — Show Us TV",
    `Confirm this email address for your Show Us TV account:\n\n${link}\n\nThe link expires in 24 hours. If you didn't request this, ignore it.`
  );
  if (!sent) {
    // Clear the pending row so the retry isn't stuck behind the cooldown.
    await c.env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?1").bind(uid).run();
    return c.json({ error: "Couldn't send the verification email — try again later" }, 502);
  }
  return c.json({ ok: true });
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
