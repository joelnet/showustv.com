// Nightly Discord daily summary (issue #10). The report that used to run on an
// external host (scripts/daily-summary.mjs, retired with this file) now runs
// directly on Cloudflare: a dedicated cron trigger routes scheduled() here
// shortly after midnight in REPORT_TIME_ZONE, and if the admin panel has a
// Discord webhook configured (app_settings, issue #8) this posts a one-day
// activity embed for the local day that just ended.
import type { Env } from "../env";
import { getDiscordSettings, isDiscordWebhookUrl } from "./discord";

// Must match a pattern in wrangler.jsonc `triggers.crons`; scheduled() compares
// event.cron against this to route the trigger here. 08:10 UTC is 00:10 PST /
// 01:10 PDT — always just past midnight in REPORT_TIME_ZONE (US DST shifts at
// 2 AM local, never midnight), so each fire lands in a fresh local day and
// summarizes exactly one completed day, once.
export const DAILY_SUMMARY_CRON = "10 8 * * *";

// THE DAY: a calendar day in this IANA zone. Matches the retired script's
// TIME_ZONE default so day boundaries (and the numbers) stay identical across
// the migration. D1 stores UTC ISO text, so the zone's midnights are converted
// to UTC instants for the query boundaries. Do not replace this with UTC day
// boundaries — the report describes US-evening activity and the numbers would
// split across the wrong days.
const REPORT_TIME_ZONE = "America/Los_Angeles";

// app_settings key recording the last local day (YYYY-MM-DD) whose summary was
// posted — the once-per-day claim postDailySummary takes before firing.
const LAST_POSTED_DAY_KEY = "discord_daily_summary_last_day";

// --- day boundaries (calendar days in REPORT_TIME_ZONE, as UTC instants) ---

interface CalendarDay {
  y: number;
  mo: number;
  d: number;
}

interface ZoneParts extends CalendarDay {
  h: number;
  mi: number;
  s: number;
}

// Wall-clock parts of an instant, observed in REPORT_TIME_ZONE.
function zoneParts(date: Date): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

// UTC instant of REPORT_TIME_ZONE's midnight on calendar day (y, mo, d).
// Fixed-point: start from UTC midnight and correct by the zone's offset at
// that instant. Two passes cover any DST wrinkle (US zones shift at 2 AM,
// never midnight, so local midnight always exists).
function zonedMidnightUtc({ y, mo, d }: CalendarDay): Date {
  let ts = Date.UTC(y, mo - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(ts));
    ts -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Date.UTC(y, mo - 1, d);
  }
  return new Date(ts);
}

// Shift a calendar date by whole days (pure calendar math, no zone involved).
function calendarShift({ y, mo, d }: CalendarDay, days: number): CalendarDay {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// The most recently COMPLETED local day as of `now`, so the just-after-midnight
// cron run covers the day that just ended, plus the start of the day before it
// for the "vs yesterday" deltas.
function dayBoundaries(now: Date): { dayStart: Date; dayEnd: Date; prevStart: Date; dayKey: string; dayLabel: string } {
  const nowParts = zoneParts(now);
  const dayEnd = zonedMidnightUtc(nowParts); // most recent local midnight
  const summarizedDay = calendarShift(nowParts, -1); // the day that just ended
  const dayStart = zonedMidnightUtc(summarizedDay);
  const prevStart = zonedMidnightUtc(calendarShift(nowParts, -2));
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dayKey = `${summarizedDay.y}-${pad2(summarizedDay.mo)}-${pad2(summarizedDay.d)}`;
  const dayLabel = dayStart.toLocaleDateString("en-US", {
    timeZone: REPORT_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return { dayStart, dayEnd, prevStart, dayKey, dayLabel };
}

// --- the day's aggregates (ported from the admin CLI's `dailystats`) ---

interface DailyStats {
  signups: number;
  signups_prev: number;
  shows_followed: number;
  shows_followed_prev: number;
  episodes_watched: number;
  episodes_watched_prev: number;
  movies_watched: number;
  movies_watched_prev: number;
  ratings: number;
  ratings_prev: number;
  comments: number;
  comments_prev: number;
  user_follows: number;
  user_follows_prev: number;
  lists_created: number;
  lists_created_prev: number;
  pwa_installs: number;
  pwa_installs_prev: number;
  active_users: number;
  active_users_prev: number;
  total_users: number;
}

// ?1 = dayStart, ?2 = dayEnd, ?3 = prevStart — all UTC ISO text, so plain
// string comparison against the *_at columns works.
const today = (col: string) => `${col} >= ?1 AND ${col} < ?2`;
const prev = (col: string) => `${col} >= ?3 AND ${col} < ?1`;
const STATS_SQL = `SELECT
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND ${today("created_at")}) AS signups,
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND ${prev("created_at")}) AS signups_prev,
  (SELECT COUNT(*) FROM user_shows WHERE ${today("added_at")}) AS shows_followed,
  (SELECT COUNT(*) FROM user_shows WHERE ${prev("added_at")}) AS shows_followed_prev,
  (SELECT COUNT(*) FROM user_episodes WHERE (${today("watched_at")}) OR (${today("last_rewatched_at")})) AS episodes_watched,
  (SELECT COUNT(*) FROM user_episodes WHERE (${prev("watched_at")}) OR (${prev("last_rewatched_at")})) AS episodes_watched_prev,
  (SELECT COUNT(*) FROM user_movies WHERE state = 'watched' AND ${today("watched_at")}) AS movies_watched,
  (SELECT COUNT(*) FROM user_movies WHERE state = 'watched' AND ${prev("watched_at")}) AS movies_watched_prev,
  (SELECT COUNT(*) FROM ratings WHERE ${today("created_at")}) AS ratings,
  (SELECT COUNT(*) FROM ratings WHERE ${prev("created_at")}) AS ratings_prev,
  (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND ${today("created_at")}) AS comments,
  (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND ${prev("created_at")}) AS comments_prev,
  (SELECT COUNT(*) FROM follows WHERE state = 'active' AND ${today("created_at")}) AS user_follows,
  (SELECT COUNT(*) FROM follows WHERE state = 'active' AND ${prev("created_at")}) AS user_follows_prev,
  (SELECT COUNT(*) FROM custom_lists WHERE ${today("created_at")}) AS lists_created,
  (SELECT COUNT(*) FROM custom_lists WHERE ${prev("created_at")}) AS lists_created_prev,
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND ${today("installed_at")}) AS pwa_installs,
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND ${prev("installed_at")}) AS pwa_installs_prev,
  (SELECT COUNT(DISTINCT user_id) FROM activity_log WHERE user_id IS NOT NULL AND ${today("ts")}) AS active_users,
  (SELECT COUNT(DISTINCT user_id) FROM activity_log WHERE user_id IS NOT NULL AND ${prev("ts")}) AS active_users_prev,
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_users`;

// --- Discord embed (same format the retired script posted) ---

function vsYesterday(todayCount: number, prevCount: number): string {
  const d = todayCount - prevCount;
  if (d === 0) return `**${todayCount}** (same as yesterday)`;
  return `**${todayCount}** (${d > 0 ? "+" + d : d} vs yesterday)`;
}

function buildPayload(s: DailyStats, dayLabel: string, dayEnd: Date): unknown {
  const field = (name: string, value: string) => ({ name, value, inline: true });
  return {
    embeds: [
      {
        title: "📊 Daily summary: " + dayLabel,
        description: "The day's activity on [Show Us TV](https://showustv.com)",
        color: 0x5865f2,
        fields: [
          field("New signups", vsYesterday(s.signups, s.signups_prev)),
          field("Shows followed", vsYesterday(s.shows_followed, s.shows_followed_prev)),
          field("Episodes watched", vsYesterday(s.episodes_watched, s.episodes_watched_prev)),
          field("Movies watched", vsYesterday(s.movies_watched, s.movies_watched_prev)),
          field("New ratings", vsYesterday(s.ratings, s.ratings_prev)),
          field("Comments", vsYesterday(s.comments, s.comments_prev)),
          field("New user follows", vsYesterday(s.user_follows, s.user_follows_prev)),
          field("Lists created", vsYesterday(s.lists_created, s.lists_created_prev)),
          field("PWA installs", vsYesterday(s.pwa_installs, s.pwa_installs_prev)),
          field("Active users", vsYesterday(s.active_users, s.active_users_prev)),
        ],
        footer: { text: `Total users: ${s.total_users} | Day boundaries: ${REPORT_TIME_ZONE}` },
        timestamp: dayEnd.toISOString(),
      },
    ],
  };
}

// Compute yesterday's activity and post it to the admin-configured Discord
// webhook. Fired once per day by the DAILY_SUMMARY_CRON trigger, with an
// atomic per-day claim making any duplicate invocation a no-op. Best-effort
// by contract: every failure is caught and logged, never thrown — a webhook
// or query hiccup can't fail the scheduled invocation. Gated ONLY on the
// webhook URL being set (the notify-on-signup checkbox is a separate toggle
// for a separate message); posting nothing when unset is the feature's off
// switch.
export async function postDailySummary(env: Env, now: Date): Promise<void> {
  try {
    const { webhookUrl } = await getDiscordSettings(env.DB);
    if (!webhookUrl) return;
    if (!isDiscordWebhookUrl(webhookUrl)) {
      console.error("daily summary: stored URL is not a Discord webhook — refusing to fire");
      return;
    }
    const { dayStart, dayEnd, prevStart, dayKey, dayLabel } = dayBoundaries(now);
    const stats = await env.DB.prepare(STATS_SQL)
      .bind(dayStart.toISOString(), dayEnd.toISOString(), prevStart.toISOString())
      .first<DailyStats>();
    if (!stats) {
      console.error("daily summary: stats query returned no row");
      return;
    }
    // Durable once-per-day guard, replacing the retired script's state file:
    // atomically claim the day in app_settings (the existing key/value table —
    // no migration) right before posting. The conditional upsert writes only
    // when the stored day differs, so of any duplicate cron fire, platform
    // retry, or manual test trigger, exactly one invocation sees a row change
    // and posts; the rest bail here.
    const claim = await env.DB.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE app_settings.value <> excluded.value`
    )
      .bind(LAST_POSTED_DAY_KEY, dayKey)
      .run();
    if (!claim.meta.changes) return; // this day's summary was already posted (or claimed)
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload(stats, dayLabel, dayEnd)),
    });
    if (!res.ok) console.error(`daily summary: webhook returned ${res.status}`);
  } catch (e) {
    console.error("daily summary failed", e);
  }
}
