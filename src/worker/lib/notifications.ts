// Notification fan-out (issue #129, comments added by #141). When a user
// watches something, every follower who has the follow-watch notification
// type enabled gets an in-app notification row; when a user comments on a
// show/movie, every follower who ALSO tracks that title gets one. Both are
// deduped per (recipient, actor, type, target) over 24 hours so a binge (or
// a back-and-forth comment thread) is one notification, not twenty. Web Push
// piggybacks on the same insert: only the rows actually created trigger a
// best-effort push, so a deduped repeat never re-buzzes a phone.
//
// Callers run these via c.executionCtx.waitUntil(...) — same pattern as the
// activity_log middleware — so fan-out cost never sits on the response path.

import type { Env } from "../env";
import { sendPush, vapidConfigured, type StoredSubscription } from "./push";

const DEDUPE_WINDOW_MS = 24 * 3600 * 1000;

// Episode code for push copy, matching the web epCode()/Slate format exactly
// (zero-padded, middle dot): "S02·E05". Kept in sync by hand — the worker and
// web bundles don't share this one-liner.
function epCode(season: number, number: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)}·E${pad(number)}`;
}

// Safety valves on fan-out: D1 caps bound parameters (chunk the IN lists) and
// Workers caps subrequests per invocation (bound the pushes; a watch by
// someone with thousands of push-subscribed followers must not hit it).
const IN_CHUNK = 50;
const MAX_PUSHES_PER_EVENT = 30;

// Best-effort Web Push of one payload to every subscribed device of the
// recipients that just got a new notification row. Shared by every fan-out.
// Each send carries that recipient's exact unread count (issue #142) so the
// service worker can badge the app icon without a page alive.
async function pushToRecipients(
  env: Env,
  recipients: number[],
  data: { title: string; body: string; url: string; tag: string }
): Promise<void> {
  const subs: (StoredSubscription & { user_id: number })[] = [];
  for (let i = 0; i < recipients.length; i += IN_CHUNK) {
    const chunk = recipients.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders}) ORDER BY id`
    )
      .bind(...chunk)
      .all<StoredSubscription & { user_id: number }>();
    subs.push(...results);
  }

  // Round-robin the per-event cap across recipients — everyone's first
  // device, then everyone's second, ... — so one person with many devices
  // can't starve other followers of their push. Deterministic (rows arrive
  // ORDER BY id) up to D1's IN-chunk boundaries.
  const byUser = new Map<number, (StoredSubscription & { user_id: number })[]>();
  for (const s of subs) {
    const list = byUser.get(s.user_id) ?? [];
    list.push(s);
    byUser.set(s.user_id, list);
  }
  const sendOrder: (StoredSubscription & { user_id: number })[] = [];
  for (let round = 0; sendOrder.length < subs.length; round++) {
    for (const list of byUser.values()) {
      if (round < list.length) sendOrder.push(list[round]);
    }
  }

  // Unread counts for the app-icon badge, batched one GROUP BY per IN-chunk
  // (never per-recipient) over only the users that actually have a device —
  // each probe is O(unread) via the partial index (0020). A user the GROUP BY
  // skips read everything between the insert and now: an exact zero, not a
  // miss. The lookup itself is best-effort — badging must never cost anyone
  // their push — so a failed chunk just leaves its users without a count and
  // their payload omits `unread` (the SW then leaves the badge alone).
  const userIds = [...byUser.keys()];
  const unreadByUser = new Map<number, number>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const chunk = userIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    try {
      const { results } = await env.DB.prepare(
        `SELECT user_id, COUNT(*) AS n FROM notifications
         WHERE user_id IN (${placeholders}) AND read_at IS NULL GROUP BY user_id`
      )
        .bind(...chunk)
        .all<{ user_id: number; n: number }>();
      const counts = new Map(results.map((r) => [r.user_id, r.n]));
      for (const id of chunk) unreadByUser.set(id, counts.get(id) ?? 0);
    } catch (e) {
      console.error("push: unread count lookup failed", e);
    }
  }

  const gone: number[] = [];
  for (const sub of sendOrder.slice(0, MAX_PUSHES_PER_EVENT)) {
    const unread = unreadByUser.get(sub.user_id);
    const payload = unread !== undefined ? { ...data, unread } : data;
    if ((await sendPush(env, sub, payload)) === "gone") gone.push(sub.id);
  }
  // Expired/unsubscribed endpoints (404/410 from the push service) are dead
  // forever — prune them so future fan-outs stop paying for them.
  if (gone.length) {
    await env.DB.batch(gone.map((id) => env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(id)));
  }
}

// Push body naming the thing: "Dexter: S02·E05 · Waiting" for an episode
// (episode title omitted when the catalog has none, or the whole episode
// clause when the episode row is gone), just the title for a movie or a
// show-level event.
function pushBody(
  targetType: "show" | "movie",
  title: string,
  ep: { season_number: number; number: number; title: string | null } | undefined
): string {
  if (targetType !== "show" || !ep) return title;
  return ep.title
    ? `${title}: ${epCode(ep.season_number, ep.number)} · ${ep.title}`
    : `${title}: ${epCode(ep.season_number, ep.number)}`;
}

export async function notifyFollowersOfWatch(
  env: Env,
  actorId: number,
  targetType: "show" | "movie",
  targetId: number,
  episodeId: number | null = null
): Promise<void> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  // One statement: fan out to active followers (skipping deleted accounts),
  // gate on each recipient's follow_watch pref (default on when they have no
  // prefs row), and dedupe against a same-actor/same-target notification in
  // the window. RETURNING tells us who actually got a new row.
  //
  // episode_id records WHICH episode this is about (the first of a binge — the
  // dedupe still keys on the show, so a binge stays one notification pinned to
  // the episode that opened it). NULL for movies and for undated catalog gaps.
  const { results: created } = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, episode_id)
     SELECT f.follower_id, 'follow_watch', ?1, ?2, ?3, ?5
     FROM follows f
     JOIN users ru ON ru.id = f.follower_id AND ru.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
       AND COALESCE((SELECT np.follow_watch FROM notification_prefs np
                     WHERE np.user_id = f.follower_id AND np.show_id = 0), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = f.follower_id AND n.type = 'follow_watch'
                         AND n.actor_id = ?1 AND n.target_type = ?2 AND n.target_id = ?3
                         AND n.created_at >= ?4)
     RETURNING user_id`
  )
    .bind(actorId, targetType, targetId, since, episodeId)
    .all<{ user_id: number }>();
  if (!created.length || !vapidConfigured(env)) return;

  // Resolve the push copy here (not in the watch routes) so the hook there
  // stays one line. Actor gone mid-flight → nothing worth pushing.
  const [actorR, titleR, epR] = await env.DB.batch([
    env.DB.prepare("SELECT username FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(actorId),
    targetType === "show"
      ? env.DB.prepare("SELECT title FROM shows WHERE tmdb_id = ?1").bind(targetId)
      : env.DB.prepare("SELECT title FROM movies WHERE tmdb_id = ?1").bind(targetId),
    // Episode details for the copy, when this is an episode watch.
    episodeId != null
      ? env.DB.prepare("SELECT season_number, number, title FROM episodes WHERE id = ?1").bind(episodeId)
      : env.DB.prepare("SELECT NULL AS season_number, NULL AS number, NULL AS title WHERE 0"),
  ]);
  const actor = (actorR.results[0] as { username: string } | undefined)?.username;
  const title = (titleR.results[0] as { title: string } | undefined)?.title;
  if (!actor || !title) return;
  const ep = epR.results[0] as { season_number: number; number: number; title: string | null } | undefined;

  // Title stays short (`<user> watched`) so it never truncates away the
  // important part; the show + episode ride in the body, which Android/iOS
  // give more room and wrap. No marketing tail — it was noise (issue #129
  // follow-up).
  await pushToRecipients(env, created.map((r) => r.user_id), {
    title: `${actor} watched`,
    body: pushBody(targetType, title, ep),
    url: `/${targetType}/${targetId}`,
    tag: `fw-${actorId}-${targetType.charAt(0)}-${targetId}`,
  });
}

// Comment fan-out (issue #141). When a user comments on a show, movie, or
// episode, notify each of their followers who ALSO tracks that title —
// "tracks" meaning the show is in their library in any non-hidden state
// (the same "also watching" membership /social/also-watching uses), or the
// movie is in user_movies (watchlist or watched). A comment on an episode
// notifies about its SHOW — the thing followers track — carrying the episode
// in episode_id, exactly like an episode watch (0021). Takes the comment's
// own target so the create route's hook stays one line; list comments never
// reach here (no tracked title to key on).
export async function notifyFollowersOfComment(
  env: Env,
  actorId: number,
  commentTargetType: "episode" | "show" | "movie",
  commentTargetId: number
): Promise<void> {
  let targetType: "show" | "movie" = "movie";
  let targetId = commentTargetId;
  let episodeId: number | null = null;
  if (commentTargetType === "episode") {
    const ep = await env.DB.prepare("SELECT show_id FROM episodes WHERE id = ?1")
      .bind(commentTargetId)
      .first<{ show_id: number }>();
    if (!ep) return; // episode vanished mid-flight — nothing to attribute
    targetType = "show";
    targetId = ep.show_id;
    episodeId = commentTargetId;
  } else if (commentTargetType === "show") {
    targetType = "show";
  }

  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  // Follower-tracks-the-title test, resolved here (not with CASE in SQL) so
  // each shape keeps its own indexed EXISTS probe.
  const tracksTitle =
    targetType === "show"
      ? `EXISTS (SELECT 1 FROM user_shows us
                 WHERE us.user_id = f.follower_id AND us.show_id = ?3 AND us.state != 'hidden')`
      : `EXISTS (SELECT 1 FROM user_movies um
                 WHERE um.user_id = f.follower_id AND um.movie_id = ?3)`;

  // One statement, mirroring the watch fan-out: active followers only,
  // deleted recipients skipped, follow_comment pref gated (default on when no
  // prefs row), and deduped per (recipient, actor, target) over 24 hours — a
  // burst of comments on one title is one notification, pinned to the episode
  // the first comment was on. The extra `au` join drops the whole fan-out
  // when the commenter is shadow-banned: their comments render as [deleted]
  // to everyone else, so a notification would advertise a comment nobody can
  // see (and leak the ban).
  const { results: created } = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, episode_id)
     SELECT f.follower_id, 'follow_comment', ?1, ?2, ?3, ?5
     FROM follows f
     JOIN users au ON au.id = f.followee_id AND au.deleted_at IS NULL AND au.shadow_banned = 0
     JOIN users ru ON ru.id = f.follower_id AND ru.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
       AND COALESCE((SELECT np.follow_comment FROM notification_prefs np
                     WHERE np.user_id = f.follower_id AND np.show_id = 0), 1) = 1
       AND ${tracksTitle}
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = f.follower_id AND n.type = 'follow_comment'
                         AND n.actor_id = ?1 AND n.target_type = ?2 AND n.target_id = ?3
                         AND n.created_at >= ?4)
     RETURNING user_id`
  )
    .bind(actorId, targetType, targetId, since, episodeId)
    .all<{ user_id: number }>();
  if (!created.length || !vapidConfigured(env)) return;

  // Push copy, resolved here so the comment route's hook stays one line.
  // Same shape as the watch push: short title (`<user> commented`), the show
  // + episode (or movie) in the body, no marketing tail. The URL deep-links
  // where the thread actually lives — the episode page for an episode
  // comment, the title page otherwise.
  const [actorR, titleR, epR] = await env.DB.batch([
    env.DB.prepare("SELECT username FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(actorId),
    targetType === "show"
      ? env.DB.prepare("SELECT title FROM shows WHERE tmdb_id = ?1").bind(targetId)
      : env.DB.prepare("SELECT title FROM movies WHERE tmdb_id = ?1").bind(targetId),
    episodeId != null
      ? env.DB.prepare("SELECT season_number, number, title FROM episodes WHERE id = ?1").bind(episodeId)
      : env.DB.prepare("SELECT NULL AS season_number, NULL AS number, NULL AS title WHERE 0"),
  ]);
  const actor = (actorR.results[0] as { username: string } | undefined)?.username;
  const title = (titleR.results[0] as { title: string } | undefined)?.title;
  if (!actor || !title) return;
  const ep = epR.results[0] as { season_number: number; number: number; title: string | null } | undefined;

  await pushToRecipients(env, created.map((r) => r.user_id), {
    title: `${actor} commented`,
    body: pushBody(targetType, title, ep),
    url: episodeId != null ? `/episode/${episodeId}` : `/${targetType}/${targetId}`,
    tag: `fc-${actorId}-${targetType.charAt(0)}-${targetId}`,
  });
}
