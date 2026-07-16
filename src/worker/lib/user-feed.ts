// Per-user RSS 2.0 watch-history feed (issue #330). `run_worker_first` already
// routes /u/* to the Worker; index.ts matches /u/:username/feed.xml here BEFORE
// the social-preview handler (which also owns /u/*) and calls serveUserFeed.
//
// Contents: the last 30 days of the user's watch history — episodes (TV +
// anime) and movies — newest first, capped at ITEM_CAP, mirroring the
// Watch Now → History surface.
//
// Gate: PUBLIC profiles only. Feed readers send no session cookie, so a
// mutual-follow unlock is impractical — the only workable audience is
// "anyone". So the gate is exactly the social-preview rule (profile_public =
// 1); a private or unknown user 404s with an identical body, so the feed
// neither leaks a private profile's watches nor confirms the account exists.
// Hidden shows (issue #260) are excluded, matching the profile history rows in
// routes/public.ts (both the `hidden = 1` flag and the `state = 'hidden'`
// tombstone). Every dynamic value is XML-escaped — nothing is trusted raw.

import { mediaPath } from "../../web/paths";
import type { Env } from "../env";

// Exactly /u/:username/feed.xml. The charset mirrors USERNAME_RE
// (src/worker/lib/username.ts) and the social-preview USER_PATH_RE, so a
// non-username path can't reach the feed builder.
export const FEED_PATH_RE = /^\/u\/([A-Za-z0-9_]{3,20})\/feed\.xml$/;

const WINDOW_DAYS = 30;
const ITEM_CAP = 50;

interface EpisodeWatch {
  episode_id: number;
  show_title: string;
  season: number;
  number: number;
  episode_title: string | null;
  ts: string;
}

interface MovieWatch {
  movie_id: number;
  movie_title: string;
  ts: string;
}

// A single feed entry, already resolved to display strings + absolute links.
interface FeedItem {
  title: string;
  link: string;
  guid: string;
  ts: string; // ISO 8601 UTC, from the DB
}

export async function serveUserFeed(req: Request, env: Env, username: string): Promise<Response> {
  // run_worker_first is not method-aware; only reads make sense for a feed.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

  try {
    // The one gate that matters, baked into the query exactly like the
    // social-preview profile card: profile_public = 1. No session unlocks —
    // feed readers are anonymous and their caches are shared. Private/unknown
    // both fall here and 404 identically (no existence oracle).
    const owner = await env.DB.prepare(
      "SELECT id, username FROM users WHERE username = ?1 AND profile_public = 1 AND deleted_at IS NULL"
    )
      .bind(username)
      .first<{ id: number; username: string }>();
    if (!owner) return notFound();

    const url = new URL(req.url);
    // Match social-preview's origin rule: always https in the real world so
    // links aren't emitted as http; localhost keeps its scheme/port for dev.
    const origin = /^(localhost|127\.\d+\.\d+\.\d+)$/.test(url.hostname) ? url.origin : `https://${url.host}`;
    // toISOString() yields the exact stored shape (…THH:MM:SS.sssZ), so the
    // string comparison below is a correct chronological cutoff.
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

    const [epsR, movsR] = await env.DB.batch([
      env.DB.prepare(
        `SELECT e.id AS episode_id, s.title AS show_title,
                e.season_number AS season, e.number AS number, e.title AS episode_title,
                CASE WHEN ue.last_rewatched_at > ue.watched_at THEN ue.last_rewatched_at ELSE ue.watched_at END AS ts
         FROM user_episodes ue
         JOIN episodes e ON e.id = ue.episode_id
         JOIN shows s ON s.tmdb_id = e.show_id
         WHERE ue.user_id = ?1 AND e.season_number > 0
           AND (CASE WHEN ue.last_rewatched_at > ue.watched_at THEN ue.last_rewatched_at ELSE ue.watched_at END) >= ?2
           AND NOT EXISTS (SELECT 1 FROM user_shows h
                           WHERE h.user_id = ?1 AND h.show_id = e.show_id
                             AND (h.state = 'hidden' OR h.hidden = 1))
         ORDER BY ts DESC
         LIMIT ${ITEM_CAP}`
      ).bind(owner.id, cutoff),
      env.DB.prepare(
        `SELECT m.tmdb_id AS movie_id, m.title AS movie_title, um.watched_at AS ts
         FROM user_movies um
         JOIN movies m ON m.tmdb_id = um.movie_id
         WHERE um.user_id = ?1 AND um.state = 'watched' AND um.watched_at IS NOT NULL
           AND um.watched_at >= ?2
         ORDER BY um.watched_at DESC
         LIMIT ${ITEM_CAP}`
      ).bind(owner.id, cutoff),
    ]);

    const items = mergeItems(
      origin,
      owner.username,
      epsR.results as unknown as EpisodeWatch[],
      movsR.results as unknown as MovieWatch[]
    );

    const xmlBody = renderFeed(origin, owner.username, items);
    const headers = new Headers({
      "content-type": "application/rss+xml; charset=utf-8",
      // Public content; a short edge/reader cache is fine and bounds how long
      // a flip to private lingers.
      "cache-control": "public, max-age=300",
    });
    return new Response(req.method === "HEAD" ? null : xmlBody, { status: 200, headers });
  } catch (e) {
    console.error("user feed failed", e);
    return notFound();
  }
}

function mergeItems(origin: string, username: string, eps: EpisodeWatch[], movs: MovieWatch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of eps) {
    const code = `S${e.season}E${e.number}`;
    const label = `${e.show_title} ${code}${e.episode_title ? `: ${e.episode_title}` : ""}`;
    items.push({
      title: `Watched ${label}`,
      link: origin + mediaPath("episode", e.episode_id, e.episode_title),
      // Opaque, stable per watch instance (episode + effective time). Not a
      // permalink → isPermaLink="false" in the output.
      guid: `showustv:${username}:episode:${e.episode_id}:${e.ts}`,
      ts: e.ts,
    });
  }
  for (const m of movs) {
    items.push({
      title: `Watched ${m.movie_title}`,
      link: origin + mediaPath("movie", m.movie_id, m.movie_title),
      guid: `showustv:${username}:movie:${m.movie_id}:${m.ts}`,
      ts: m.ts,
    });
  }
  // Newest first across both sources; same fixed-width ISO shape → lexical
  // compare is chronological. Cap after the merge.
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return items.slice(0, ITEM_CAP);
}

function renderFeed(origin: string, username: string, items: FeedItem[]): string {
  const profileUrl = `${origin}/u/${username}`;
  const selfUrl = `${profileUrl}/feed.xml`;
  const title = `@${username} on Show Us TV`;
  const description = `Recent watch history for @${username} on Show Us TV — the last ${WINDOW_DAYS} days of movies, TV, and anime.`;
  // "last content change" — newest item's time, or now for an empty feed.
  const lastBuild = rfc822(items.length ? items[0].ts : new Date().toISOString());

  const body = items
    .map(
      (it) =>
        `    <item>\n` +
        `      <title>${xml(it.title)}</title>\n` +
        `      <link>${xml(it.link)}</link>\n` +
        `      <guid isPermaLink="false">${xml(it.guid)}</guid>\n` +
        `      <pubDate>${rfc822(it.ts)}</pubDate>\n` +
        `      <description>${xml(it.title)}</description>\n` +
        `    </item>`
    )
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    <title>${xml(title)}</title>\n` +
    `    <link>${xml(profileUrl)}</link>\n` +
    `    <atom:link href="${xml(selfUrl)}" rel="self" type="application/rss+xml"/>\n` +
    `    <description>${xml(description)}</description>\n` +
    `    <language>en-us</language>\n` +
    `    <generator>Show Us TV</generator>\n` +
    `    <lastBuildDate>${lastBuild}</lastBuildDate>\n` +
    (body ? body + "\n" : "") +
    `  </channel>\n` +
    `</rss>\n`
  );
}

// RFC 822 date-time (RSS pubDate/lastBuildDate). toUTCString() emits the
// RFC 1123 4-digit-year variant every feed reader accepts, always in GMT.
function rfc822(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString();
}

// Escape text/attribute content for XML 1.0. Strips control characters the
// spec forbids (a stray one would make the whole feed non-well-formed), then
// escapes markup. `&` first so we don't double-escape the entities we add.
function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
