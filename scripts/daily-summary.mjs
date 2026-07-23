#!/usr/bin/env node
// daily-summary — nightly cron job that posts a one-day activity summary to
// Discord (issue #168).
//
// It asks the admin CLI for the day's aggregates (`dailystats --remote`) and
// posts a Discord embed: new signups (vs yesterday), shows followed, episodes
// watched, plus movies watched, ratings, comments, new user follows, lists
// created, PWA installs, active users, and the running user total.
//
//   node scripts/daily-summary.mjs
//
// THE DAY: a calendar day in TIME_ZONE (America/Los_Angeles, matching the
// crontab's CRON_TZ). The script always summarizes the most recently COMPLETED
// local day, so the midnight cron run covers the day that just ended. D1
// stores UTC ISO text, so the zone's midnights are converted to UTC instants
// for the query boundaries. Do not replace this with UTC day boundaries — the
// machine is not UTC and the numbers would be wrong.
//
// Config via environment (all optional; also read from the gitignored .env.local):
//   DISCORD_WEBHOOK_URL   webhook to post to (required to actually post)
//   TIME_ZONE             IANA zone that defines "the day"
//                         (default: America/Los_Angeles)
//   STATE_FILE            where to record the last day posted
//                         (default: ~/.local/state/showustv/daily-summary.json)
//   TARGET                "remote" (default) or "local" — which DB to query
//   DRY_RUN=1             compute and log the payload, but don't POST or write state
//   FORCE=1               post even if this day's summary was already sent
//
// Exit status: 0 on success (posted or skipped as already-sent), 1 on any
// error. On error it does NOT write the state file, so a rerun will post.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Cron runs with a bare PATH. `node` and `npx` (which the admin CLI shells out
// to) live next to the interpreter running us, so make sure that dir is on PATH
// for the child processes.
const NODE_BIN_DIR = dirname(process.execPath);
process.env.PATH = `${NODE_BIN_DIR}:${process.env.PATH || ""}`;

// Load .env.local (gitignored) so DISCORD_WEBHOOK_URL and CLOUDFLARE_API_TOKEN
// are available even under cron's empty environment. Existing env wins.
function loadEnvLocal() {
  const p = join(REPO_ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TIME_ZONE = process.env.TIME_ZONE || "America/Los_Angeles";
const STATE_FILE =
  process.env.STATE_FILE ||
  join(homedir(), ".local", "state", "showustv", "daily-summary.json");
const TARGET = process.env.TARGET === "local" ? "local" : "remote";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";

const stamp = () => new Date().toISOString();
const log = (...a) => console.log(stamp(), ...a);

function die(msg) {
  console.error(stamp(), "ERROR:", msg);
  process.exit(1);
}

// --- day boundaries (calendar days in TIME_ZONE, as UTC instants) ---

// Wall-clock parts of an instant, observed in TIME_ZONE.
function zoneParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

// UTC instant of TIME_ZONE's midnight on calendar day (y, mo, d). Fixed-point:
// start from UTC midnight and correct by the zone's offset at that instant.
// Two passes cover any DST wrinkle (US zones shift at 2 AM, never midnight,
// so local midnight always exists).
function zonedMidnightUtc({ y, mo, d }) {
  let ts = Date.UTC(y, mo - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(ts));
    ts -= Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Date.UTC(y, mo - 1, d);
  }
  return new Date(ts);
}

// Shift a calendar date by whole days (pure calendar math, no zone involved).
function calendarShift({ y, mo, d }, days) {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const nowParts = zoneParts(new Date());
const dayEnd = zonedMidnightUtc(nowParts); // most recent local midnight
const summarizedDay = calendarShift(nowParts, -1); // the day that just ended
const dayStart = zonedMidnightUtc(summarizedDay);
const prevStart = zonedMidnightUtc(calendarShift(nowParts, -2));

const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = `${summarizedDay.y}-${pad2(summarizedDay.mo)}-${pad2(summarizedDay.d)}`;
const dayLabel = dayStart.toLocaleDateString("en-US", {
  timeZone: TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

// --- day's aggregates, via the admin CLI (never touches D1 directly) ---
const STAT_KEYS = [
  "signups", "signups_prev",
  "shows_followed", "shows_followed_prev",
  "episodes_watched", "episodes_watched_prev",
  "movies_watched", "movies_watched_prev",
  "ratings", "ratings_prev",
  "comments", "comments_prev",
  "user_follows", "user_follows_prev",
  "lists_created", "lists_created_prev",
  "pwa_installs", "pwa_installs_prev",
  "active_users", "active_users_prev",
  "total_users",
];

function fetchDailyStats() {
  const args = [
    "scripts/admin.mjs", "dailystats", "--json",
    "--start", dayStart.toISOString(),
    "--end", dayEnd.toISOString(),
    "--prev-start", prevStart.toISOString(),
  ];
  if (TARGET === "remote") args.push("--remote");
  let out;
  try {
    out = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 << 20,
    });
  } catch (e) {
    die("admin CLI failed:\n" + (e.stderr || e.stdout || e.message || e));
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    die("could not parse CLI output:\n" + out);
  }
  if (data && data.ok === false) die("CLI reported: " + data.error);
  for (const k of STAT_KEYS) {
    if (!Number.isFinite(Number(data?.[k]))) die(`CLI returned no "${k}":\n` + out);
  }
  return data;
}

// --- state (last day posted) — keeps a rerun from posting the same day twice ---
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null; // missing or unreadable → nothing posted yet
  }
}

function writeState() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ day: dayKey, postedAt: stamp() }, null, 2) + "\n"
  );
}

// --- Discord ---
function vsYesterday(today, prev) {
  const d = today - prev;
  if (d === 0) return `**${today}** (same as yesterday)`;
  return `**${today}** (${d > 0 ? "+" + d : d} vs yesterday)`;
}

function buildPayload(s) {
  const field = (name, value) => ({ name, value, inline: true });
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
        footer: { text: `Total users: ${s.total_users} | Day boundaries: ${TIME_ZONE}` },
        timestamp: dayEnd.toISOString(),
      },
    ],
  };
}

async function postDiscord(payload) {
  if (!WEBHOOK) die("DISCORD_WEBHOOK_URL is not set (add it to .env.local)");
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`Discord webhook returned ${res.status} ${res.statusText}: ${body}`);
  }
}

// --- main ---
log(
  `summarizing ${dayKey} (${TIME_ZONE}): ` +
    `${dayStart.toISOString()} .. ${dayEnd.toISOString()} ` +
    `(previous day from ${prevStart.toISOString()}, target: ${TARGET})`
);

const state = readState();
if (state?.day === dayKey && !FORCE) {
  log(`already posted for ${dayKey} at ${state.postedAt} — skipping (FORCE=1 to repost)`);
  process.exit(0);
}

const stats = fetchDailyStats();
log(
  "stats:",
  JSON.stringify(Object.fromEntries(STAT_KEYS.map((k) => [k, stats[k]])))
);

const payload = buildPayload(stats);
if (DRY_RUN) {
  log("DRY_RUN: would post →", JSON.stringify(payload, null, 2));
} else {
  await postDiscord(payload);
  writeState();
  log(`posted summary for ${dayKey} to Discord`);
}
log("done");
