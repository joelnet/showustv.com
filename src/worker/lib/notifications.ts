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
     JOIN users au ON au.id = f.followee_id
     WHERE f.followee_id = ?1 AND f.state = 'active'
       -- "X watched Y" IS the actor's watch activity, so it obeys the same
       -- visibility rule as the activity feed (issue #205): the actor's profile
       -- is public or mutual with the recipient. And like the feed, a show the
       -- ACTOR hid (issue #260) never fans out — the notification would
       -- broadcast exactly what hiding conceals. The separate activity_public
       -- gate was dropped (issue #308): #249 removed the toggle that set it, so
       -- gating on that frozen flag permanently silenced watch notifications to
       -- the followers of any user whose flag was 0.
       AND (?2 != 'show' OR NOT EXISTS (SELECT 1 FROM user_shows ah
                                        WHERE ah.user_id = ?1 AND ah.show_id = ?3 AND ah.hidden = 1))
       AND (au.profile_public = 1 OR EXISTS (
             SELECT 1 FROM follows r
             WHERE r.follower_id = f.followee_id AND r.followee_id = f.follower_id AND r.state = 'active'))
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
  // each shape keeps its own indexed EXISTS probe. A recipient who HID the
  // show (issue #260) doesn't count as tracking it: a push naming it on
  // their lock screen would leak exactly what hiding conceals.
  const tracksTitle =
    targetType === "show"
      ? `EXISTS (SELECT 1 FROM user_shows us
                 WHERE us.user_id = f.follower_id AND us.show_id = ?3
                   AND us.state != 'hidden' AND us.hidden = 0)`
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
       -- The ACTOR hid this show (issue #260): the comment stays public on
       -- its thread, but no notification may broadcast the association.
       AND (?2 != 'show' OR NOT EXISTS (SELECT 1 FROM user_shows ah
                                        WHERE ah.user_id = ?1 AND ah.show_id = ?3 AND ah.hidden = 1))
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

// Followers are usually far fewer than trackers of a hit title, but a
// favorite by a big account still shouldn't write unbounded rows in one
// invocation — cap the INSERT like the tracker fan-out below (lowest
// follower ids win, deterministically). The push cap still applies on top.
const MAX_FAVORITE_FANOUT = 500;

// Favorite fan-out (issue #266). When a user favorites a show or movie,
// their followers hear about it — "X favorited Y" — linking to the title
// page. The routes (the heart endpoints, and the list-items endpoint when
// the target list is the Favorites system list) only call this when the
// favorite INSERT actually created a row (a re-favorite of something
// already in the list is a no-op there), and the 24h dedupe below absorbs
// heart-toggle flapping on top of that.
export async function notifyFollowersOfFavorite(
  env: Env,
  actorId: number,
  targetType: "show" | "movie",
  targetId: number
): Promise<void> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  // One statement, mirroring the watch fan-out: active followers only (self
  // can't appear — follows CHECKs follower != followee), deleted recipients
  // skipped, follow_favorite pref gated (default on when no prefs row), and
  // deduped per (recipient, actor, target) over 24 hours. The `au` join
  // drops the whole fan-out when the favoriter is deleted or shadow-banned —
  // their profile reads as gone to everyone else, so a notification would
  // advertise (and link) an account nobody can see.
  const { results: created } = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, target_type, target_id)
     SELECT f.follower_id, 'follow_favorite', ?1, ?2, ?3
     FROM follows f
     JOIN users au ON au.id = f.followee_id AND au.deleted_at IS NULL AND au.shadow_banned = 0
     JOIN users ru ON ru.id = f.follower_id AND ru.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
       -- A show the ACTOR hid (issue #260) never fans out — the notification
       -- would broadcast exactly what hiding conceals.
       AND (?2 != 'show' OR NOT EXISTS (SELECT 1 FROM user_shows ah
                                        WHERE ah.user_id = ?1 AND ah.show_id = ?3 AND ah.hidden = 1))
       -- Favorites are profile content: on a private profile the favorites
       -- list is visible to mutuals only (public.ts profileGate), so the
       -- notification obeys the same rule — a follower who couldn't see the
       -- favorite on the profile doesn't hear about it either. This is now the
       -- same visibility rule the watch fan-out uses, after issue #308 dropped
       -- the old (frozen, unsettable) activity_public gate from that path.
       AND (au.profile_public = 1 OR EXISTS (
             SELECT 1 FROM follows r
             WHERE r.follower_id = f.followee_id AND r.followee_id = f.follower_id AND r.state = 'active'))
       AND COALESCE((SELECT np.follow_favorite FROM notification_prefs np
                     WHERE np.user_id = f.follower_id AND np.show_id = 0), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = f.follower_id AND n.type = 'follow_favorite'
                         AND n.actor_id = ?1 AND n.target_type = ?2 AND n.target_id = ?3
                         AND n.created_at >= ?4)
     ORDER BY f.follower_id
     LIMIT ?5
     RETURNING user_id`
  )
    .bind(actorId, targetType, targetId, since, MAX_FAVORITE_FANOUT)
    .all<{ user_id: number }>();
  if (!created.length || !vapidConfigured(env)) return;

  // Push copy, resolved here so the favorite routes' hook stays one line.
  // Same shape as the watch push: short title (`<user> favorited`), the
  // show/movie in the body, deep link to the title page.
  const [actorR, titleR] = await env.DB.batch([
    env.DB.prepare("SELECT username FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(actorId),
    targetType === "show"
      ? env.DB.prepare("SELECT title FROM shows WHERE tmdb_id = ?1").bind(targetId)
      : env.DB.prepare("SELECT title FROM movies WHERE tmdb_id = ?1").bind(targetId),
  ]);
  const actor = (actorR.results[0] as { username: string } | undefined)?.username;
  const title = (titleR.results[0] as { title: string } | undefined)?.title;
  if (!actor || !title) return;

  await pushToRecipients(env, created.map((r) => r.user_id), {
    title: `${actor} favorited`,
    body: title,
    url: `/${targetType}/${targetId}`,
    tag: `ffav-${actorId}-${targetType.charAt(0)}-${targetId}`,
  });
}

// Same fan-out cap as favorites (lowest follower ids win, deterministically) —
// a list published by a big account still writes at most this many rows in one
// invocation. The push cap above still applies on top.
const MAX_LIST_FANOUT = 500;

// New-list fan-out (issue #331). When a user's custom list first becomes BOTH
// public (custom_lists.is_shared = 1) AND pinned to their profile
// (profile_position IS NOT NULL), their followers hear about it — "X created a
// new list: <name>" — linking to the list. The two callers (the visibility
// endpoint publishing an already-pinned list, and the profile-pin endpoint
// pinning an already-public list) invoke this only on the transition INTO that
// combined state, so populating a list first and sharing it later is exactly
// one notification. The list is genuinely public content (the /lists/:u/:id
// share endpoint gates on is_shared alone, ignoring profile privacy), so —
// unlike the favorite/watch fan-outs — there is no profile_public visibility
// gate here: any follower can open the linked list. Deduped per
// (recipient, actor, list) over 24 hours, absorbing pin/publish flapping and
// the two-endpoint "make public and pin in one action" path (whichever
// transition lands second is deduped away).
export async function notifyFollowersOfListCreated(
  env: Env,
  actorId: number,
  listId: number
): Promise<void> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  // One statement, mirroring the favorite fan-out: active followers only (self
  // can't appear — follows CHECKs follower != followee), deleted recipients
  // skipped, list_created pref gated (default on when no prefs row), and
  // deduped per (recipient, actor, list) over 24 hours. The `au` join drops the
  // whole fan-out when the list owner is deleted or shadow-banned — their
  // profile reads as gone to everyone else, so a notification would advertise
  // (and link) content nobody should be pointed at.
  const { results: created } = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, target_type, target_id)
     SELECT f.follower_id, 'list_created', ?1, 'list', ?2
     FROM follows f
     JOIN users au ON au.id = f.followee_id AND au.deleted_at IS NULL AND au.shadow_banned = 0
     JOIN users ru ON ru.id = f.follower_id AND ru.deleted_at IS NULL
     WHERE f.followee_id = ?1 AND f.state = 'active'
       AND COALESCE((SELECT np.list_created FROM notification_prefs np
                     WHERE np.user_id = f.follower_id AND np.show_id = 0), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = f.follower_id AND n.type = 'list_created'
                         AND n.actor_id = ?1 AND n.target_id = ?2
                         AND n.created_at >= ?3)
     ORDER BY f.follower_id
     LIMIT ?4
     RETURNING user_id`
  )
    .bind(actorId, listId, since, MAX_LIST_FANOUT)
    .all<{ user_id: number }>();
  if (!created.length || !vapidConfigured(env)) return;

  // Push copy, resolved here so the routes' hook stays one line. Short title
  // (`<user> created a list`), the list name in the body, deep link to the
  // shared list page (the numeric id resolves without the slug — the page
  // canonicalizes the URL once the name loads).
  const [actorR, listR] = await env.DB.batch([
    env.DB.prepare("SELECT username FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(actorId),
    env.DB.prepare("SELECT name FROM custom_lists WHERE id = ?1").bind(listId),
  ]);
  const actor = (actorR.results[0] as { username: string } | undefined)?.username;
  const name = (listR.results[0] as { name: string } | undefined)?.name;
  if (!actor || !name) return;

  await pushToRecipients(env, created.map((r) => r.user_id), {
    title: `${actor} created a list`,
    body: name,
    url: `/u/${actor}/lists/${listId}`,
    tag: `flist-${actorId}-${listId}`,
  });
}

// Follow notification (issue #273). When A follows B, B hears about it —
// "A followed you", or "A followed you back" when B already follows A (A's
// follow reciprocated one of B's). Single recipient, not a fan-out. The row
// stores type + actor only (target_type/target_id stay NULL — the actor IS
// the target); the read side computes live whether the recipient follows
// the actor back, so the client's Follow back button can never go stale.
// The route only calls this when the follows INSERT actually created a row
// (re-following is a no-op there), and the 24h dedupe below absorbs
// unfollow/refollow flapping on top of that — keyed on BOTH types, so a
// refollow can't re-buzz under the other wording.
export async function notifyUserOfFollow(env: Env, actorId: number, followeeId: number): Promise<void> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  // Same guards as the fan-outs: deleted recipient skipped, deleted or
  // shadow-banned actor drops the notification — their profile reads as gone
  // to everyone else, so it would advertise (and link) an account nobody can
  // see — and the new_follower pref gates it (default on when no prefs row).
  // Self-follow can't reach here (the route rejects it and follows CHECKs
  // follower != followee). Reciprocation picks the type at INSERT time:
  // "followed you back" is a fact about the moment A followed, not about
  // the current graph, so it's baked into the row rather than recomputed.
  const created = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id)
     SELECT ru.id,
            CASE WHEN EXISTS (SELECT 1 FROM follows r
                              WHERE r.follower_id = ?2 AND r.followee_id = ?1 AND r.state = 'active')
                 THEN 'follow_back' ELSE 'follow' END,
            ?1
     FROM users ru
     JOIN users au ON au.id = ?1 AND au.deleted_at IS NULL AND au.shadow_banned = 0
     WHERE ru.id = ?2 AND ru.deleted_at IS NULL
       AND COALESCE((SELECT np.new_follower FROM notification_prefs np
                     WHERE np.user_id = ?2 AND np.show_id = 0), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = ?2 AND n.type IN ('follow', 'follow_back')
                         AND n.actor_id = ?1 AND n.created_at >= ?3)
     RETURNING type`
  )
    .bind(actorId, followeeId, since)
    .first<{ type: string }>();
  if (!created || !vapidConfigured(env)) return;

  // Push copy: the event IS the whole message, so the title carries it and
  // the body suggests the next step. Deep link to the notifications page
  // (issue #280), not the actor's profile — that's where the Follow back
  // button lives, so following back is one tap away, and the actor's name
  // there still links their profile for anyone who wants the detour.
  const actor = await env.DB.prepare("SELECT username FROM users WHERE id = ?1 AND deleted_at IS NULL")
    .bind(actorId)
    .first<{ username: string }>();
  if (!actor) return;

  await pushToRecipients(env, [followeeId], {
    title:
      created.type === "follow_back" ? `${actor.username} followed you back` : `${actor.username} followed you`,
    body: created.type === "follow_back" ? "You now follow each other" : "Open your notifications to follow back",
    url: "/notifications",
    tag: `fl-${actorId}`,
  });
}

// Admin test notification (issue #275): the admin page's "Send test
// notification" button targets the admin THEMSELVES, so they can verify the
// whole pipeline — the in-app row behind the bell plus Web Push to this
// account's subscribed devices — without involving anyone else. Deliberately
// no dedupe window and no pref gate: every click must deliver, that's the
// point of a test. Unlike the fan-outs this is awaited on the response path
// (routes/admin.ts) so the button's toast reflects the insert actually
// happening; push stays best-effort inside sendPush, so a flaky push service
// can't fail the request.
export async function notifyTestNotification(env: Env, uid: number): Promise<void> {
  // The admin is their own actor, so the notifications page renders the row
  // as "<username> sent a test notification" with no null-actor special case.
  // No media target — target_type/target_id stay NULL, like follow rows.
  await env.DB.prepare("INSERT INTO notifications (user_id, type, actor_id) VALUES (?1, 'test', ?1)")
    .bind(uid)
    .run();
  if (!vapidConfigured(env)) return;
  await pushToRecipients(env, [uid], {
    title: "Test notification",
    body: "Push notifications are working on this device.",
    url: "/notifications",
    // Stable tag: rapid re-tests replace the previous banner instead of
    // stacking a pile of identical notifications on the lock screen.
    tag: `test-${uid}`,
  });
}

// A popular title can have far more trackers than anyone has followers, so
// unlike the follow fan-outs the tracker fan-out bounds its INSERT too (the
// lowest user ids win, deterministically) — one runaway thread on a hit show
// must not write tens of thousands of rows per comment. The push cap above
// still applies on top.
const MAX_TRACKER_FANOUT = 500;

// Tracker fan-out (issue #236). When ANY user comments on a show, movie, or
// episode, notify every OTHER user who tracks that title — same "tracks"
// membership as the follow_comment fan-out above (show in the library in any
// non-hidden state, or any user_movies row) but without the follows edge:
// you don't need to follow the commenter to hear about your own shows. An
// episode comment notifies about its SHOW, carrying the episode in
// episode_id, exactly like follow_comment. Gated per recipient on the
// tracked_comment pref (0027, default on when no prefs row).
//
// Runs AFTER notifyFollowersOfComment (the comment route chains them) and
// dedupes against BOTH comment types, so a follower-who-tracks gets the
// richer follow_comment row and never a duplicate tracked_comment for the
// same actor/title within the window.
export async function notifyTrackersOfComment(
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

  // Recipients come straight from the tracking table (the media-first
  // indexes from 0027 make this a title probe, not a table scan), not from
  // follows. Same guards as the fan-outs
  // above: the actor's own comment never notifies them, deleted recipients
  // are skipped, and a shadow-banned or deleted actor drops the whole
  // fan-out — their comments render as [deleted] to everyone else, so a
  // notification would advertise a comment nobody can see (and leak the ban).
  // As in the follow_comment fan-out, a tracker who hid the show (issue
  // #260) is skipped — no notification (or lock-screen push) may name it.
  const trackers =
    targetType === "show"
      ? `SELECT us.user_id AS uid FROM user_shows us
         WHERE us.show_id = ?3 AND us.state != 'hidden' AND us.hidden = 0`
      : `SELECT um.user_id AS uid FROM user_movies um WHERE um.movie_id = ?3`;

  const { results: created } = await env.DB.prepare(
    `INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, episode_id)
     SELECT t.uid, 'tracked_comment', ?1, ?2, ?3, ?5
     FROM (${trackers}) t
     JOIN users au ON au.id = ?1 AND au.deleted_at IS NULL AND au.shadow_banned = 0
     JOIN users ru ON ru.id = t.uid AND ru.deleted_at IS NULL
     WHERE t.uid != ?1
       -- Actor-hid-the-show guard (issue #260), as in the follow fan-outs.
       AND (?2 != 'show' OR NOT EXISTS (SELECT 1 FROM user_shows ah
                                        WHERE ah.user_id = ?1 AND ah.show_id = ?3 AND ah.hidden = 1))
       AND COALESCE((SELECT np.tracked_comment FROM notification_prefs np
                     WHERE np.user_id = t.uid AND np.show_id = 0), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM notifications n
                       WHERE n.user_id = t.uid AND n.type IN ('tracked_comment', 'follow_comment')
                         AND n.actor_id = ?1 AND n.target_type = ?2 AND n.target_id = ?3
                         AND n.created_at >= ?4)
     ORDER BY t.uid
     LIMIT ?6
     RETURNING user_id`
  )
    .bind(actorId, targetType, targetId, since, episodeId, MAX_TRACKER_FANOUT)
    .all<{ user_id: number }>();
  if (!created.length || !vapidConfigured(env)) return;

  // Push copy: the recipient may not know the commenter, so the title leads
  // with the event ("New comment") and the actor rides in the body with the
  // tracked title. Same deep-link rule as follow_comment — the episode page
  // when the thread lives there, the title page otherwise.
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
    title: "New comment",
    body: `${actor} on ${pushBody(targetType, title, ep)}`,
    url: episodeId != null ? `/episode/${episodeId}` : `/${targetType}/${targetId}`,
    tag: `tc-${actorId}-${targetType.charAt(0)}-${targetId}`,
  });
}
