// Notification fan-out (issue #129). When a user watches something, every
// follower who has the follow-watch notification type enabled gets an in-app
// notification row, deduped per (recipient, actor, target) over 24 hours so a
// binge is one notification, not twenty. Web Push piggybacks on the same
// insert: only the rows actually created trigger a best-effort push, so a
// deduped repeat never re-buzzes a phone.
//
// Callers run this via c.executionCtx.waitUntil(...) — same pattern as the
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

  // Every push-subscribed device of every recipient that got a new row.
  const recipients = created.map((r) => r.user_id);
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
  const byUser = new Map<number, StoredSubscription[]>();
  for (const s of subs) {
    const list = byUser.get(s.user_id) ?? [];
    list.push(s);
    byUser.set(s.user_id, list);
  }
  const sendOrder: StoredSubscription[] = [];
  for (let round = 0; sendOrder.length < subs.length; round++) {
    for (const list of byUser.values()) {
      if (round < list.length) sendOrder.push(list[round]);
    }
  }

  // Title stays short (`<user> watched`) so it never truncates away the
  // important part; the show + episode ride in the body, which Android/iOS
  // give more room and wrap. No marketing tail — it was noise (issue #129
  // follow-up). For an episode: "Dexter: S2·E5 · Waiting" (episode title
  // omitted when the catalog has none, or the whole episode clause when the
  // episode row is gone). For a movie: just the movie title.
  const body =
    targetType === "show" && ep
      ? ep.title
        ? `${title}: ${epCode(ep.season_number, ep.number)} · ${ep.title}`
        : `${title}: ${epCode(ep.season_number, ep.number)}`
      : title;
  const data = {
    title: `${actor} watched`,
    body,
    url: `/${targetType}/${targetId}`,
    tag: `fw-${actorId}-${targetType.charAt(0)}-${targetId}`,
  };
  const gone: number[] = [];
  for (const sub of sendOrder.slice(0, MAX_PUSHES_PER_EVENT)) {
    if ((await sendPush(env, sub, data)) === "gone") gone.push(sub.id);
  }
  // Expired/unsubscribed endpoints (404/410 from the push service) are dead
  // forever — prune them so future fan-outs stop paying for them.
  if (gone.length) {
    await env.DB.batch(gone.map((id) => env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(id)));
  }
}
