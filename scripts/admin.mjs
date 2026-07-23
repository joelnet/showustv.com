#!/usr/bin/env node
// showustv-admin — a small, scriptable admin CLI for Show Us TV (issue #27).
//
// It talks straight to the D1 database via `wrangler d1 execute`, so it needs
// no running server and no auth — just run it from the repo root. It is
// deliberately non-interactive and supports `--json` on every command, so an
// agent (or a shell script) can drive it and parse the output.
//
//   node scripts/admin.mjs <command> [args] [--remote] [--json]
//
// SAFETY: defaults to the LOCAL dev database. Pass --remote to act on
// production. Run `node scripts/admin.mjs help` for the full command list.

import { execFileSync } from "node:child_process";

// ---------- args ----------

const argv = process.argv.slice(2);
const flags = { remote: false, json: false };
const opts = {}; // --key value / --key=value
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--remote") flags.remote = true;
  else if (a === "--json") flags.json = true;
  else if (a === "--errors") opts.errors = true;
  else if (a === "--revoke") opts.revoke = true;
  else if (a === "--unban") opts.unban = true;
  else if (a === "-h" || a === "--help") positional.unshift("help");
  else if (a.startsWith("--")) {
    const [k, v] = a.includes("=") ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
    opts[k] = v;
  } else positional.push(a);
}
const command = positional.shift();

// ---------- db access ----------

const DB = "showustv";
const qstr = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // SQLite string literal
const like = (s) => "'%" + String(s).replace(/'/g, "''").replace(/[%_]/g, (m) => "\\" + m) + "%'";

function run(sql) {
  const args = ["wrangler", "d1", "execute", DB, flags.remote ? "--remote" : "--local", "--json", "--command", sql];
  let out;
  try {
    out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || "").toString();
    fail("database error:\n" + msg.trim());
  }
  // With --json, stdout is a JSON array of result blocks; be tolerant of any
  // leading banner wrangler might print.
  const start = out.indexOf("[");
  try {
    const blocks = JSON.parse(start >= 0 ? out.slice(start) : out);
    return blocks[blocks.length - 1] ?? { results: [], meta: {} };
  } catch {
    fail("could not parse database output:\n" + out.trim());
  }
}

const rows = (sql) => run(sql).results ?? [];
// wrangler's --json meta omits the affected-row count, so ask SQLite directly:
// changes() reflects the preceding statement, returned as the last block.
const changes = (sql) => run(`${sql}; SELECT changes() AS n`).results?.[0]?.n ?? 0;

// ---------- output ----------

function fail(msg) {
  if (flags.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error("✗ " + msg);
  process.exit(1);
}

function emit(data, renderHuman) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else renderHuman(data);
}

// Minimal aligned table for human output.
function table(items, columns) {
  if (!items.length) return console.log("(none)");
  const cols = columns ?? Object.keys(items[0]);
  const widths = cols.map((c) => Math.max(c.length, ...items.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of items) console.log(line(cols.map((c) => r[c])));
}

// ---------- commands ----------

const commands = {
  activity() {
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 50));
    const where = ["1=1"];
    if (opts.user) where.push(`u.username = ${qstr(opts.user)}`);
    if (opts.errors) where.push("a.status >= 400");
    if (opts.status) where.push(`a.status = ${Number(opts.status) | 0}`);
    const data = rows(
      `SELECT a.ts, a.method, a.status, a.path, u.username
       FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(" AND ")}
       ORDER BY a.id DESC LIMIT ${limit}`
    );
    emit(data, (d) => table(d, ["ts", "method", "status", "username", "path"]));
  },

  users() {
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 50));
    const where = ["deleted_at IS NULL"];
    if (opts.search) where.push(`(username LIKE ${like(opts.search)} ESCAPE '\\' OR email LIKE ${like(opts.search)} ESCAPE '\\')`);
    const data = rows(
      `SELECT id, username, email, is_admin, shadow_banned, created_at
       FROM users WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${limit}`
    );
    emit(data, (d) => table(d, ["id", "username", "email", "is_admin", "shadow_banned", "created_at"]));
  },

  user() {
    const who = positional[0];
    if (!who) fail("usage: user <email|username>");
    const u = rows(
      `SELECT id, username, email, tz, is_admin, shadow_banned, email_verified_at, created_at, deleted_at
       FROM users WHERE email = ${qstr(who)} OR username = ${qstr(who)}`
    )[0];
    if (!u) fail(`no user matching ${JSON.stringify(who)}`);
    const [stats] = rows(
      `SELECT
         (SELECT COUNT(*) FROM user_shows WHERE user_id = ${u.id | 0}) AS shows,
         (SELECT COUNT(*) FROM user_episodes WHERE user_id = ${u.id | 0}) AS episodes_watched,
         (SELECT COUNT(*) FROM user_movies WHERE user_id = ${u.id | 0} AND state = 'watched') AS movies_watched,
         (SELECT COUNT(*) FROM comments WHERE user_id = ${u.id | 0} AND deleted_at IS NULL) AS comments`
    );
    emit({ ...u, ...stats }, (d) => {
      for (const [k, v] of Object.entries(d)) console.log(`${k.padEnd(18)} ${v ?? ""}`);
    });
  },

  admin() {
    const who = positional[0];
    if (!who) fail("usage: admin <username> [--revoke]");
    const grant = !opts.revoke;
    const n = changes(`UPDATE users SET is_admin = ${grant ? 1 : 0} WHERE username = ${qstr(who)} AND deleted_at IS NULL`);
    if (!n) fail(`no user named ${JSON.stringify(who)}`);
    emit({ ok: true, username: who, isAdmin: grant }, (d) => console.log(`✓ ${d.username} is ${d.isAdmin ? "now an admin" : "no longer an admin"}`));
  },

  ban() {
    const who = positional[0];
    if (!who) fail("usage: ban <username> [--unban]");
    const val = opts.unban ? 0 : 1;
    const n = changes(`UPDATE users SET shadow_banned = ${val} WHERE username = ${qstr(who)} AND deleted_at IS NULL`);
    if (!n) fail(`no user named ${JSON.stringify(who)}`);
    emit({ ok: true, username: who, shadowBanned: !!val }, (d) => console.log(`✓ ${d.username} ${d.shadowBanned ? "shadow-banned" : "un-banned"}`));
  },

  stats() {
    const [s] = rows(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users,
         (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins,
         (SELECT COUNT(*) FROM users WHERE shadow_banned = 1) AS shadow_banned,
         (SELECT COUNT(*) FROM user_episodes) AS episodes_watched,
         (SELECT COUNT(*) FROM shows) AS shows_cached,
         (SELECT COUNT(*) FROM activity_log WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) AS requests_24h`
    );
    emit(s, (d) => {
      for (const [k, v] of Object.entries(d)) console.log(`${k.padEnd(18)} ${v}`);
    });
  },

  usercount() {
    // Single COUNT of active users (matches the in-app signup ping's total).
    const [r] = rows(`SELECT COUNT(*) AS users FROM users WHERE deleted_at IS NULL`);
    emit(r, (d) => console.log(d.users));
  },

  dailystats() {
    // One-day activity aggregates for the nightly Discord summary (issue #168).
    // The caller (scripts/daily-summary.mjs) computes the day boundaries from
    // the machine's LOCAL calendar day and passes them as UTC ISO timestamps —
    // all *_at columns in D1 are UTC ISO text, so plain string comparison works.
    //   --start       start of the day being summarized (inclusive)
    //   --end         end of that day (exclusive)
    //   --prev-start  start of the previous day (for the "vs yesterday" deltas)
    const iso = (name) => {
      const v = opts[name];
      if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v))
        fail(`dailystats requires --${name} as a UTC ISO timestamp, e.g. 2026-07-09T07:00:00.000Z`);
      return qstr(v);
    };
    const start = iso("start");
    const end = iso("end");
    const prevStart = iso("prev-start");
    const today = (col) => `${col} >= ${start} AND ${col} < ${end}`;
    const prev = (col) => `${col} >= ${prevStart} AND ${col} < ${start}`;
    const [s] = rows(
      `SELECT
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
         (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_users`
    );
    emit(s, (d) => {
      for (const [k, v] of Object.entries(d)) console.log(`${k.padEnd(22)} ${v}`);
    });
  },

  sql() {
    const query = positional.join(" ");
    if (!query) fail('usage: sql "SELECT ..."  (read-only)');
    if (!/^\s*select\b/i.test(query) || /;/.test(query.replace(/;\s*$/, "")))
      fail("sql accepts a single read-only SELECT only. Use the dedicated commands for changes.");
    emit(rows(query), (d) => table(d));
  },

  help() {
    console.log(`showustv-admin — admin CLI for Show Us TV

Usage: node scripts/admin.mjs <command> [args] [--remote] [--json]

Targets the LOCAL dev DB by default; pass --remote for production.
Every command supports --json for machine-readable output.

Commands:
  activity [--limit N] [--user NAME] [--status N] [--errors]
                             recent mutating requests from the audit log
  users [--search TERM] [--limit N]
                             list / search accounts and their flags
  user <email|username>      one account's details + watch counts
  admin <username> [--revoke]        grant or revoke admin
  ban <username> [--unban]           shadow-ban or un-ban a user
  stats                      quick counts across the whole instance
  usercount                  just the active-user count (fast)
  dailystats --start ISO --end ISO --prev-start ISO
                             one-day activity aggregates (used by the nightly
                             Discord summary cron; boundaries are UTC ISO)
  sql "SELECT …"             run a single read-only query
  help                       this text

Examples:
  node scripts/admin.mjs users --search someone@example.com --remote
  node scripts/admin.mjs activity --errors --limit 20 --json
  node scripts/admin.mjs stats --remote`);
  },
};

// ---------- dispatch ----------

if (!command || command === "help") {
  commands.help();
  process.exit(command ? 0 : 1);
}
const fn = commands[command];
if (!fn) fail(`unknown command: ${command}. Run "help" for the list.`);
fn();
