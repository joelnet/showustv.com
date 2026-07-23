// The signed-in user's profile: watch stats, public/private visibility, and
// which of their lists are pinned to it (and in what order). The public,
// unauthenticated view lives in routes/public.ts.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";
import { nowIso } from "../lib/dates";
import { USERNAME_RE, USERNAME_RULES } from "../lib/username";
import { notifyFollowersOfListCreated } from "../lib/notifications";
import { dispatchEmailVerification } from "../lib/verify-email";
import { verifyPassword } from "../lib/password";
import { isRateLimited, recordAttempt, clearAttempts } from "../lib/rate-limit";

export const profile = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_GAP_MS = 60_000;
// Failures-only brake on the email-change password re-auth, in the
// spirit of /login: a live session must not become an unthrottled oracle for
// guessing the account password. Per IP and per account; only wrong passwords
// are counted (see below), so a legitimate change never trips it.
const EMAIL_PW_IP = { limit: 10, windowMs: 15 * 60_000 };
const EMAIL_PW_UID = { limit: 5, windowMs: 15 * 60_000 };

profile.get("/", async (c) => {
  const uid = c.get("uid");
  const [userR, statsR, listsR, postersR, pendingR, achR, followR] = await c.env.DB.batch([
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
    // Follow counts for the profile header — same live-user
    // filter as /social/follows so the numbers match that page's lists.
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows f JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
          WHERE f.follower_id = ?1 AND f.state = 'active') AS following,
         (SELECT COUNT(*) FROM follows f JOIN users u ON u.id = f.follower_id AND u.deleted_at IS NULL
          WHERE f.followee_id = ?1 AND f.state = 'active') AS followers`
    ).bind(uid),
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
  const follow = followR.results[0] as { following: number; followers: number };
  return c.json({
    username: user.username,
    isPublic: !!user.profile_public,
    email: user.email,
    emailVerified: !!user.email_verified_at,
    pendingEmail: pending && pending.expires_at > nowIso() ? pending.email : null,
    achievements: (achR.results as any[]).map((r) => ({ id: r.achievement_id, unlockedAt: r.unlocked_at })),
    stats: statsFromRow(statsR.results[0]),
    followingCount: follow.following,
    followersCount: follow.followers,
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
  const password = String(body.password ?? "");
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: "That doesn't look like an email address" }, 400);

  // Re-authenticate before moving an ALREADY-VERIFIED address: a
  // live session must prove the account password before it can point the
  // account at a new email, so a hijacked session can't silently start a
  // takeover. Gated on an existing verified address only — first-time
  // verification of the signup email (no verified address yet) stays
  // frictionless, and that path is already covered by the epoch bump on verify
  // plus the old-address notification the swap sends.
  const acct = await c.env.DB.prepare("SELECT pw_hash, email_verified_at FROM users WHERE id = ?1")
    .bind(uid)
    .first<{ pw_hash: string | null; email_verified_at: string | null }>();
  if (acct?.email_verified_at && acct.pw_hash) {
    const ipKey = `email:ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
    const uidKey = `email:uid:${uid}`;
    if (await isRateLimited(c.env.DB, [{ key: ipKey, ...EMAIL_PW_IP }, { key: uidKey, ...EMAIL_PW_UID }]))
      return c.json({ error: "Too many attempts. Please try again later" }, 429);
    if (!password || !(await verifyPassword(password, acct.pw_hash))) {
      await recordAttempt(c.env.DB, [ipKey, uidKey]); // count only wrong passwords
      return c.json({ error: "That password is incorrect" }, 401);
    }
    await clearAttempts(c.env.DB, [uidKey]); // a correct password ends the account's failure window
  }

  // Verified-email uniqueness is enforced at claim time too (0001 UNIQUE),
  // but failing fast here beats a dead link in someone's inbox.
  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?1 AND id != ?2").bind(email, uid).first();
  if (taken) return c.json({ error: "That email is already in use" }, 409);

  const prev = await c.env.DB.prepare("SELECT sent_at FROM email_verifications WHERE user_id = ?1")
    .bind(uid)
    .first<{ sent_at: string }>();
  if (prev && Date.now() - Date.parse(prev.sent_at) < RESEND_GAP_MS)
    return c.json({ error: "Verification email just sent. Give it a minute" }, 429);

  const sent = await dispatchEmailVerification(c.env, new URL(c.req.url).origin, uid, email);
  if (!sent) {
    // Clear the pending row so the retry isn't stuck behind the cooldown.
    await c.env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?1").bind(uid).run();
    return c.json({ error: "Couldn't send the verification email. Try again later" }, 502);
  }
  return c.json({ ok: true });
});

// Change the auto-assigned handle. Sign-up hands out a random
// username; this is where a user renames it. Case-insensitively unique.
profile.put("/username", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  if (!USERNAME_RE.test(username)) return c.json({ error: USERNAME_RULES }, 400);
  try {
    await c.env.DB.prepare("UPDATE users SET username = ?2 WHERE id = ?1").bind(c.get("uid"), username).run();
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return c.json({ error: "That username is taken" }, 409);
    throw e;
  }
  return c.json({ ok: true, username });
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
  // RETURNING is_shared fires only on the actual not-pinned→pinned transition
  // (the WHERE requires profile_position IS NULL), so a re-pin returns nothing.
  // When the newly pinned list is already public, it has just entered the
  // combined (public AND on-profile) state and its followers get a list_created
  // notification — scenario A ("list is public, then added to the
  // profile"). The 24h dedupe in the fan-out absorbs re-pin flapping and the
  // parallel make-public path.
  const pinned = await c.env.DB.prepare(
    `UPDATE custom_lists
     SET profile_position = (SELECT COALESCE(MAX(profile_position) + 1, 0)
                             FROM custom_lists WHERE user_id = ?1)
     WHERE id = ?2 AND user_id = ?1 AND profile_position IS NULL
     RETURNING is_shared`
  )
    .bind(uid, listId)
    .first<{ is_shared: number }>();
  if (!pinned) {
    const owned = await c.env.DB.prepare("SELECT 1 FROM custom_lists WHERE id = ?1 AND user_id = ?2")
      .bind(listId, uid)
      .first();
    if (!owned) return c.json({ error: "not found" }, 404);
  } else if (pinned.is_shared === 1) {
    c.executionCtx.waitUntil(
      notifyFollowersOfListCreated(c.env, uid, listId).catch((e) => console.error("notify failed", e))
    );
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
