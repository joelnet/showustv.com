#!/usr/bin/env node
// notify-new-users — cron job that pings Discord when new people sign up.
//
// It asks the admin CLI for the current active-user count (`usercount --remote`),
// compares it to the count recorded on the previous run (a tiny JSON state file),
// and if the number went up, posts a message to a Discord webhook saying how many
// new users signed up. Designed to be run unattended from cron on this machine.
//
//   node scripts/notify-new-users.mjs
//
// Config via environment (all optional; also read from the gitignored .env.local):
//   DISCORD_WEBHOOK_URL   webhook to post to (required to actually notify)
//   STATE_FILE            where to persist the last count
//                         (default: ~/.local/state/showustv/user-count.json)
//   TARGET                "remote" (default) or "local" — which DB to count
//   DRY_RUN=1             compute and log, but don't POST or write state
//
// Exit status: 0 on success (whether or not it notified), 1 on any error. On
// error it does NOT overwrite the state file, so the next run still sees the
// real previous count and won't miss signups.

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
const STATE_FILE =
  process.env.STATE_FILE ||
  join(homedir(), ".local", "state", "showustv", "user-count.json");
const TARGET = process.env.TARGET === "local" ? "local" : "remote";
const DRY_RUN = process.env.DRY_RUN === "1";

const stamp = () => new Date().toISOString();
const log = (...a) => console.log(stamp(), ...a);

function die(msg) {
  console.error(stamp(), "ERROR:", msg);
  process.exit(1);
}

// --- current active-user count, via the admin CLI (never touches D1 directly) ---
function currentUserCount() {
  const args = ["scripts/admin.mjs", "usercount", "--json"];
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
  const n = Number(data && data.users);
  if (!Number.isFinite(n)) die("CLI returned no user count:\n" + out);
  return n;
}

// --- state (last count) ---
function readPrevCount() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Number.isFinite(s.users) ? s.users : null;
  } catch {
    return null; // missing or unreadable → treat as first run
  }
}

function writeState(users) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ users, updatedAt: stamp() }, null, 2) + "\n"
  );
}

// --- Discord ---
async function postDiscord(content) {
  if (!WEBHOOK) die("DISCORD_WEBHOOK_URL is not set (add it to .env.local)");
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`Discord webhook returned ${res.status} ${res.statusText}: ${body}`);
  }
}

// --- main ---
const count = currentUserCount();
const prev = readPrevCount();
log(`active users: ${count} (previous: ${prev === null ? "none" : prev}, target: ${TARGET})`);

if (prev === null) {
  log("first run — recording baseline, no notification");
  if (!DRY_RUN) writeState(count);
  process.exit(0);
}

const delta = count - prev;

if (delta > 0) {
  const noun = delta === 1 ? "new user" : "new users";
  const content =
    `🎉 **${delta} ${noun}** signed up on [Show Us TV](https://showustv.com)!\n` +
    `Total users: **${count}** (was ${prev}).`;
  log(`+${delta} — notifying Discord`);
  if (!DRY_RUN) await postDiscord(content);
  else log("DRY_RUN: would post →", JSON.stringify(content));
} else if (delta < 0) {
  log(`count dropped by ${-delta} (accounts removed) — no notification`);
} else {
  log("no change — no notification");
}

if (!DRY_RUN) writeState(count);
log("done");
