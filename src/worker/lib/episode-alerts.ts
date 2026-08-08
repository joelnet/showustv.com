// Air-date alerts: "a show you watch airs today". TMDB has air DATES only —
// never times — so an alert is due on the episode's air date once the clock
// in the recipient's timezone passes their chosen delivery time
// (users.notify_min, minutes past local midnight, default 8:00 AM).
//
// Runs every 5 minutes (EPISODE_ALERTS_CRON) in two independent phases:
//
//   Generation — set-based and idempotent. For each distinct user timezone,
//   one INSERT OR IGNORE finds every (tracker, show) pair with an episode
//   airing on that zone's local today whose delivery time has passed, keyed
//   PRIMARY KEY (user_id, show_id, air_date) so re-runs are no-ops and a
//   multi-episode drop day is ONE alert ("8 episodes today"). The same
//   D1 batch (one transaction) inserts the in-app notification rows, so
//   ledger and bell can't diverge. Catch-up semantics, not exact-minute:
//   the alert fires on the FIRST run past the threshold, which rides out
//   missed runs, DST jumps, and mid-day settings changes, and never fires
//   for a past date.
//
//   Delivery — the unbounded-fan-out half. Web Push is one subrequest per
//   device, so a popular show's thousands of pushes can't happen in one
//   invocation (Workers subrequest cap). Pending rows (pushed_at IS NULL)
//   are claimed in small atomic batches (UPDATE ... RETURNING — each row won
//   exactly once, even under overlapping runs) and pushed until the queue is
//   empty or this run's send/wall budget is hit; the backlog carries to the
//   next run. Claim-then-send = at-most-once push; the in-app row from
//   generation is the durable record. Bell-only users (no push devices, or
//   VAPID unconfigured) drain through the same claim so pending never
//   accumulates.
//
// Unlike the social fan-outs in lib/notifications.ts there is NO per-event
// push cap and NO actor: this is a system notice aimed at every tracker.

import type { Env } from "../env";
import { localMinutesInTz, nowIso, todayInTz } from "./dates";
import { sendPush, vapidConfigured, type PushData, type StoredSubscription } from "./push";
import { pushBody, subscriptionsFor, unreadCounts, pruneSubscriptions } from "./notifications";

// Must match an entry in wrangler.jsonc triggers.crons; scheduled() routes on it.
export const EPISODE_ALERTS_CRON = "*/5 * * * *";

// Ledger rows claimed per UPDATE — small so a mid-batch death strands few
// claimed-but-unsent pushes (accepted at-most-once cost).
const CLAIM_BATCH = 25;
// Sends per run: subrequest headroom on the paid plan's 1000/invocation —
// sendPush can fetch twice (429/5xx retry) and delivery shares the budget
// with its D1 lookups. ~7,200 pushes/hour across runs; deeper backlogs just
// take another run or two.
const MAX_SENDS_PER_RUN = 600;
// Workers allow ~6 simultaneous outbound connections; stay under it.
const PUSH_CONCURRENCY = 5;
// Leave the 5-minute slot long before the next trigger fires.
const WALL_BUDGET_MS = 3.5 * 60_000;

// One INSERT OR IGNORE per timezone bucket. ?1 = that zone's local today,
// ?2 = tz, ?3 = minutes past local midnight right now, ?4 = run stamp.
// Recipient predicate matches the Upcoming rail's spirit: actively tracking
// ('watching' or caught-up 'up_to_date'), not hidden (0029 — a lock-screen
// push must not leak what hiding conceals), regular seasons only, gated by
// the global push_new_episode pref (default on via COALESCE, like every
// other fan-out). The inner GROUP BY leans on SQLite's documented single-
// MIN bare-column rule: e.id comes from the row achieving MIN(ord), i.e.
// the first episode of the day, as the representative.
const GENERATE_SQL = `
INSERT OR IGNORE INTO episode_alerts (user_id, show_id, air_date, episode_id, ep_count, created_at)
SELECT user_id, show_id, air_date, episode_id, ep_count, ?4
FROM (
  SELECT us.user_id            AS user_id,
         e.show_id             AS show_id,
         e.air_date            AS air_date,
         e.id                  AS episode_id,
         COUNT(*)              AS ep_count,
         MIN(e.season_number * 100000 + e.number) AS ord
  FROM episodes e
  JOIN user_shows us ON us.show_id = e.show_id
    AND us.state IN ('watching', 'up_to_date')
    AND us.hidden = 0
  JOIN users u ON u.id = us.user_id
    AND u.deleted_at IS NULL
    AND u.tz = ?2
    AND u.notify_min <= ?3
  WHERE e.air_date = ?1
    AND e.season_number > 0
    AND COALESCE((SELECT np.push_new_episode FROM notification_prefs np
                  WHERE np.user_id = us.user_id AND np.show_id = 0), 1) = 1
  GROUP BY us.user_id, e.show_id
)`;

// Same batch (same transaction): an in-app row for every alert this run
// created. pushed_at IS NULL keeps it on the partial index; the stamp
// equality picks out exactly this run's inserts.
const NOTIFY_SQL = `
INSERT INTO notifications (user_id, type, actor_id, target_type, target_id, episode_id)
SELECT user_id, 'new_episode', NULL, 'show', show_id, episode_id
FROM episode_alerts
WHERE created_at = ?1 AND pushed_at IS NULL`;

// Atomic claim: only one concurrent run can win a given row. Tuple-IN
// because UPDATE ... LIMIT needs a SQLite compile flag D1 doesn't guarantee.
const CLAIM_SQL = `
UPDATE episode_alerts SET pushed_at = ?1
WHERE pushed_at IS NULL
  AND (user_id, show_id, air_date) IN (
    SELECT user_id, show_id, air_date FROM episode_alerts
    WHERE pushed_at IS NULL
    ORDER BY created_at, user_id, show_id
    LIMIT ?2)
RETURNING user_id, show_id, air_date, episode_id, ep_count`;

interface ClaimedAlert {
  user_id: number;
  show_id: number;
  air_date: string;
  episode_id: number;
  ep_count: number;
}

export async function runEpisodeAlerts(env: Env): Promise<void> {
  const started = Date.now();

  // Phases are independent on purpose: a generation failure (bad tz data, a
  // D1 hiccup) must not stop this run from draining yesterday's backlog, and
  // vice versa.
  let generated = 0;
  try {
    generated = await generateAlerts(env);
  } catch (e) {
    console.error("episode-alerts: generation failed", e);
  }

  let claimed = 0;
  let pushed = 0;
  let pruned = 0;
  try {
    ({ claimed, pushed, pruned } = await deliverAlerts(env, started + WALL_BUDGET_MS));
  } catch (e) {
    console.error("episode-alerts: delivery failed", e);
  }

  let backlog = -1; // -1 = count itself failed; never worth failing the run over
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM episode_alerts WHERE pushed_at IS NULL").first<{ n: number }>();
    backlog = row?.n ?? -1;
  } catch {}
  console.log(
    `episode-alerts: generated=${generated} claimed=${claimed} pushed=${pushed} prunedEndpoints=${pruned} backlog=${backlog} ms=${Date.now() - started}`
  );
}

async function generateAlerts(env: Env): Promise<number> {
  const stamp = nowIso();
  // Distinct timezones in use — a small set (tens at most), each becoming
  // one set-based statement. A show with 10,000 trackers in one zone is
  // still a single INSERT.
  const { results: zones } = await env.DB.prepare("SELECT DISTINCT tz FROM users WHERE deleted_at IS NULL").all<{ tz: string }>();
  if (!zones.length) return 0;
  const stmts = zones.map(({ tz }) =>
    env.DB.prepare(GENERATE_SQL).bind(todayInTz(tz), tz, localMinutesInTz(tz), stamp)
  );
  stmts.push(env.DB.prepare(NOTIFY_SQL).bind(stamp));
  const results = await env.DB.batch(stmts);
  // The trailing NOTIFY_SQL's change count = fresh alerts this run.
  return results[results.length - 1]?.meta?.changes ?? 0;
}

async function deliverAlerts(env: Env, deadline: number): Promise<{ claimed: number; pushed: number; pruned: number }> {
  const canPush = vapidConfigured(env);
  let claimed = 0;
  let pushed = 0;
  let pruned = 0;
  while (Date.now() < deadline && pushed < MAX_SENDS_PER_RUN) {
    const { results: batch } = await env.DB.prepare(CLAIM_SQL).bind(nowIso(), CLAIM_BATCH).all<ClaimedAlert>();
    if (!batch.length) break;
    claimed += batch.length;
    // No VAPID: keep claiming (cheap UPDATEs) so the pending set drains
    // instead of growing forever; the in-app rows already exist.
    if (!canPush) continue;
    const sent = await pushBatch(env, batch);
    pushed += sent.pushed;
    pruned += sent.pruned;
  }
  return { claimed, pushed, pruned };
}

// Push one claimed batch: resolve display copy live (a since-deleted
// representative episode degrades to show-only text, same LEFT-join
// philosophy as the notifications read model), then fan out to every device
// of every recipient — no per-event cap, that's the whole point here.
async function pushBatch(env: Env, batch: ClaimedAlert[]): Promise<{ pushed: number; pruned: number }> {
  const showIds = [...new Set(batch.map((a) => a.show_id))];
  const epIds = [...new Set(batch.map((a) => a.episode_id))];
  const [showRes, epRes] = await env.DB.batch([
    env.DB.prepare(`SELECT tmdb_id, title FROM shows WHERE tmdb_id IN (${placeholders(showIds.length)})`).bind(...showIds),
    env.DB.prepare(`SELECT id, season_number, number, title FROM episodes WHERE id IN (${placeholders(epIds.length)})`).bind(...epIds),
  ]);
  const titles = new Map((showRes.results as { tmdb_id: number; title: string }[]).map((s) => [s.tmdb_id, s.title]));
  const eps = new Map(
    (epRes.results as { id: number; season_number: number; number: number; title: string | null }[]).map((e) => [e.id, e])
  );

  const userIds = [...new Set(batch.map((a) => a.user_id))];
  const subs = await subscriptionsFor(env, userIds);
  if (!subs.length) return { pushed: 0, pruned: 0 };
  const byUser = new Map<number, (StoredSubscription & { user_id: number })[]>();
  for (const s of subs) {
    const list = byUser.get(s.user_id) ?? [];
    list.push(s);
    byUser.set(s.user_id, list);
  }
  const unreadByUser = await unreadCounts(env, [...byUser.keys()]);

  const jobs: { sub: StoredSubscription & { user_id: number }; data: PushData }[] = [];
  for (const alert of batch) {
    const devices = byUser.get(alert.user_id);
    if (!devices) continue;
    // "New episode · Dexter: S02·E05 · Waiting", or the count form for a
    // multi-episode drop day; tag collapses re-sends per (show, day) on the
    // device.
    const title = titles.get(alert.show_id) ?? "A show you watch";
    const ep = eps.get(alert.episode_id);
    const data: PushData = {
      title: alert.ep_count > 1 ? "New episodes" : "New episode",
      body: alert.ep_count > 1 ? `${title}: ${alert.ep_count} episodes today` : pushBody("show", title, ep),
      url: `/show/${alert.show_id}`,
      tag: `ne-${alert.show_id}-${alert.air_date}`,
    };
    for (const sub of devices) {
      const unread = unreadByUser.get(alert.user_id);
      jobs.push({ sub, data: unread !== undefined ? { ...data, unread } : data });
    }
  }

  const gone: number[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(PUSH_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if ((await sendPush(env, job.sub, job.data, "normal")) === "gone") gone.push(job.sub.id);
    }
  });
  await Promise.all(workers);
  await pruneSubscriptions(env, gone);
  return { pushed: jobs.length, pruned: gone.length };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");
}
