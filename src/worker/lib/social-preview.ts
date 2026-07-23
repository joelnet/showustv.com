// Per-page social previews. `run_worker_first` sends /show/*, /movie/*, and
// /episode/* plus /u/* to the Worker, which serves
// the SPA shell with the <head> rewritten for that specific page so link
// unfurlers (Discord, Slack, iMessage, Twitter/X, Facebook) render the
// title's name, overview, and artwork, a public profile's username, or a
// shared list's name and cover — instead of the generic
// landing-page card. Real visitors get the same shell — the SPA hydrates
// regardless of what's in <head> — so there is no crawler user-agent
// sniffing to keep in sync.
//
// Security: TMDB-sourced text (titles, overviews), usernames, and
// user-authored list names/preambles are injected exclusively through
// HTMLRewriter's setAttribute()/setInnerContent(), which HTML-escape their
// input. Nothing is string-concatenated into markup. Private profiles — and
// private/unshared lists — get the untouched landing shell, identical to an
// unknown username or id, so a preview can neither leak their data nor confirm
// that they exist.

import { mediaPath, publicListPath, type MediaType } from "../../web/paths";
import type { Env } from "../env";

// Only the leading digits identify the record; any "-slug" suffix is advisory
// (see src/web/paths.ts). Anchored: sub-paths like /show/123/x aren't title
// pages (the SPA route is exactly /show/:id) and must not get a title card.
const TITLE_PATH_RE = /^\/(show|movie|episode)\/(\d+)(?:-[^/]*)?\/?$/;

// Profile pages: exactly /u/:username. The charset mirrors
// USERNAME_RE (src/worker/lib/username.ts) — anything else can't be a real
// username. Shared-list sub-paths get their own card (LIST_PATH_RE below);
// other sub-paths like /u/:username/library or /u/:username/achievements keep
// the landing card.
const USER_PATH_RE = /^\/u\/([A-Za-z0-9_]{3,20})\/?$/;

// Public list pages: /u/:username/lists/:id-slug.
// Like TITLE_PATH_RE, only the leading digits identify the list; the "-slug"
// is advisory. Anchored to the exact SPA route (/u/:username/lists/:id, see
// src/web/app.tsx) so deeper sub-paths never get a list card.
const LIST_PATH_RE = /^\/u\/([A-Za-z0-9_]{3,20})\/lists\/(\d+)(?:-[^/]*)?\/?$/;

export function isSocialPreviewPath(pathname: string): boolean {
  return /^\/(show|movie|episode|u)\//.test(pathname);
}

interface Artwork {
  url: string;
  width: number;
  height: number;
  type: string;
  alt: string;
  // Landscape backdrops read well as big cards; portrait posters would be
  // center-cropped by summary_large_image, so they get the thumbnail card.
  card: "summary" | "summary_large_image";
}

interface PreviewMeta {
  name: string; // og:title / twitter:title — carries the year for card disambiguation
  tab: string; // <title> text — no year, matching what the SPA sets client-side (useDocumentTitle)
  description: string;
  ogType: string;
  url: string; // canonical URL with fresh slug
  image: Artwork | null; // null → leave the landing og.png tags in place
  feedUrl?: string; // public profiles only: RSS autodiscovery target
}

// Every title- and profile-page request lands here (all methods —
// run_worker_first is not method-aware). Anything that isn't a GET for a
// known title or a PUBLIC profile falls through to the static-asset server,
// which behaves exactly as it did before this route existed (SPA fallback
// shell with the landing-page meta).
export async function serveSocialPreview(req: Request, env: Env): Promise<Response> {
  const fallback = () => env.ASSETS.fetch(req);
  if (req.method !== "GET") return fallback();
  try {
    const url = new URL(req.url);
    // og:url is the canonical URL scrapers dedupe on — always https in the
    // real world (plain-http fetches would otherwise emit an http canonical).
    // localhost keeps its scheme/port so `wrangler dev` links stay clickable.
    const origin = /^(localhost|127\.\d+\.\d+\.\d+)$/.test(url.hostname) ? url.origin : `https://${url.host}`;
    const title = TITLE_PATH_RE.exec(url.pathname);
    const list = title ? null : LIST_PATH_RE.exec(url.pathname);
    const user = title || list ? null : USER_PATH_RE.exec(url.pathname);
    const meta = title
      ? await lookupMeta(env, title[1] as MediaType, Number(title[2]), origin)
      : list
        ? await lookupListMeta(env, list[1], Number(list[2]), origin)
        : user
          ? await lookupUserMeta(env, user[1], origin)
          : null;
    // Unknown title (not in D1 yet), unknown/private list, unknown username,
    // private profile, or an unhandled sub-path → generic landing card,
    // byte-identical in every case.
    if (!meta) return fallback();

    // Fetch the shell with a bare request: forwarding the client's
    // conditional headers could return a bodiless 304 keyed to the generic
    // shell's ETag, which would skip the rewrite entirely.
    const shell = await env.ASSETS.fetch(new Request(new URL("/", url.origin)));
    if (!shell.ok) return fallback();

    let rewriter = new HTMLRewriter()
      .on("title", {
        element(el) {
          el.setInnerContent(`${meta.tab} — Show Us TV`);
        },
      })
      .on('meta[name="description"]', content(meta.description))
      .on('meta[property="og:type"]', content(meta.ogType))
      .on('meta[property="og:title"]', content(meta.name))
      .on('meta[property="og:description"]', content(meta.description))
      .on('meta[property="og:url"]', content(meta.url))
      .on('meta[name="twitter:title"]', content(meta.name))
      .on('meta[name="twitter:description"]', content(meta.description));
    if (meta.image) {
      rewriter = rewriter
        .on('meta[property="og:image"]', content(meta.image.url))
        .on('meta[property="og:image:type"]', content(meta.image.type))
        .on('meta[property="og:image:width"]', content(String(meta.image.width)))
        .on('meta[property="og:image:height"]', content(String(meta.image.height)))
        .on('meta[property="og:image:alt"]', content(meta.image.alt))
        .on('meta[name="twitter:card"]', content(meta.image.card))
        .on('meta[name="twitter:image"]', content(meta.image.url))
        .on('meta[name="twitter:image:alt"]', content(meta.image.alt));
    }
    if (meta.feedUrl) {
      // RSS autodiscovery. Unlike the meta rewrites above,
      // el.append() with { html: true } does NOT auto-escape — so href/title
      // are run through attr() by hand. Both derive from the request origin
      // and a [A-Za-z0-9_] username, but escaping keeps the invariant local.
      const feedTitle = attr(`${meta.name} — Show Us TV`);
      const feedHref = attr(meta.feedUrl);
      rewriter = rewriter.on("head", {
        element(el) {
          el.append(`<link rel="alternate" type="application/rss+xml" title="${feedTitle}" href="${feedHref}">`, {
            html: true,
          });
        },
      });
    }

    const out = rewriter.transform(shell);
    const headers = new Headers(out.headers);
    headers.delete("etag"); // validator describes the generic shell, not this variant
    headers.delete("content-length"); // body length changed under the rewrite
    // Same policy as the asset-served shell: always revalidate. A longer
    // max-age would let browsers reuse HTML whose hashed asset URLs vanish
    // on the next deploy. Unfurlers cache the card on their side regardless.
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return new Response(out.body, { status: out.status, headers });
  } catch (e) {
    // Never let preview generation break page loads — serve the plain shell.
    console.error("social preview failed", e);
    return fallback();
  }
}

function content(value: string) {
  return {
    element(el: Element) {
      el.setAttribute("content", value);
    },
  };
}

// Escape a double-quoted HTML attribute value for the one spot that bypasses
// HTMLRewriter's built-in escaping (the RSS <link> append above).
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ShowRow {
  title: string;
  overview: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  first_air_date: string | null;
}

interface MovieRow {
  title: string;
  overview: string | null;
  poster_url: string | null;
  release_date: string | null;
}

interface EpisodeRow {
  title: string | null;
  overview: string | null;
  season_number: number;
  number: number;
  show_title: string;
  show_overview: string | null;
  show_poster: string | null;
  show_backdrop: string | null;
}

// Plain SELECTs only — no ensureShow/ensureMovie. By the time a link is
// shared, the sharer's own page view has already synced the title into D1;
// keeping TMDB out of this path keeps unfurls fast and outage-proof.
async function lookupMeta(env: Env, type: MediaType, id: number, origin: string): Promise<PreviewMeta | null> {
  if (type === "show") {
    const row = await env.DB.prepare(
      "SELECT title, overview, poster_url, backdrop_url, first_air_date FROM shows WHERE tmdb_id = ?1"
    )
      .bind(id)
      .first<ShowRow>();
    if (!row) return null;
    return {
      name: withYear(row.title, row.first_air_date),
      tab: row.title,
      description: describe(row.overview, row.title),
      ogType: "video.tv_show",
      url: origin + mediaPath("show", id, row.title),
      image: artwork(env, row.backdrop_url, row.poster_url, row.title),
    };
  }
  if (type === "movie") {
    const row = await env.DB.prepare("SELECT title, overview, poster_url, release_date FROM movies WHERE tmdb_id = ?1")
      .bind(id)
      .first<MovieRow>();
    if (!row) return null;
    return {
      name: withYear(row.title, row.release_date),
      tab: row.title,
      description: describe(row.overview, row.title),
      ogType: "video.movie",
      url: origin + mediaPath("movie", id, row.title),
      image: artwork(env, null, row.poster_url, row.title), // movies carry no backdrop in D1
    };
  }
  const row = await env.DB.prepare(
    `SELECT e.title, e.overview, e.season_number, e.number,
            s.title AS show_title, s.overview AS show_overview,
            s.poster_url AS show_poster, s.backdrop_url AS show_backdrop
     FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
     WHERE e.id = ?1`
  )
    .bind(id)
    .first<EpisodeRow>();
  if (!row) return null;
  const code = `S${String(row.season_number).padStart(2, "0")}E${String(row.number).padStart(2, "0")}`;
  const name = `${row.show_title} ${code}${row.title ? `: ${row.title}` : ""}`;
  return {
    name,
    tab: name,
    description: describe(row.overview ?? row.show_overview, row.show_title),
    ogType: "video.episode",
    url: origin + mediaPath("episode", id, row.title),
    // The show's art represents an episode better at card sizes than a tiny
    // episode still, and its dimensions are known.
    image: artwork(env, row.show_backdrop, row.show_poster, row.show_title),
  };
}

// Public profile preview. The ONE gate that matters is baked
// into the query: profile_public = 1. This is the same server-side rule
// /api/public/profile/:username enforces (src/worker/routes/public.ts),
// minus its session-based unlocks (owner, mutual follow) — unfurlers are
// anonymous and their caches are shared, so a session must never influence
// the card. A private profile returns null here, exactly like a username
// that doesn't exist: unlike the API's "this profile is private" teaser,
// a preview card is pushed unsolicited into chats, so it must not even
// confirm existence. Only the username leaves this function — no stats,
// no lists, no activity.
async function lookupUserMeta(env: Env, username: string, origin: string): Promise<PreviewMeta | null> {
  const row = await env.DB.prepare(
    "SELECT username FROM users WHERE username = ?1 AND profile_public = 1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<{ username: string }>();
  if (!row) return null;
  const name = `@${row.username}`; // DB casing — the URL's may differ (COLLATE NOCASE)
  return {
    name,
    tab: name,
    description: `See what @${row.username} is watching on Show Us TV — shows, movies, ratings, and watch history.`,
    ogType: "profile",
    url: `${origin}/u/${row.username}`,
    image: null, // users have no avatars — the landing og.png stays in place
    // Autodiscovery target for feed readers/browsers. Only set
    // for public profiles — the same gate as this whole function — so a
    // private profile's shell never advertises a feed.
    feedUrl: `${origin}/u/${row.username}/feed.xml`,
  };
}

interface ListRow {
  name: string;
  preamble: string | null;
  username: string; // DB casing — the URL's may differ (COLLATE NOCASE)
  count: number;
  poster: string | null; // first item's poster, or NULL for an empty/art-less list
}

// Public list preview. The gate is baked into the WHERE, mirroring
// GET /api/public/lists/:username/:id (src/worker/routes/public.ts): a list is
// previewable only when is_shared = 1 and its owner isn't deleted — the exact
// server-side rule the shared-list page itself enforces. A private/unshared
// list, a wrong owner, or an unknown id returns null, so its card is the
// untouched landing shell: a preview pushed unsolicited into a chat must never
// leak an unshared list's name/cover or confirm it exists. Only the list name,
// owner username, item count, an optional owner-written preamble, and the first
// item's poster leave this function — all already public on the shared page.
// The poster subquery correlates on l.id and so only runs once the outer row
// has passed the share gate — a private list's items are never read.
async function lookupListMeta(env: Env, username: string, id: number, origin: string): Promise<PreviewMeta | null> {
  const row = await env.DB.prepare(
    `SELECT l.name, l.preamble, u.username,
            (SELECT COUNT(*) FROM custom_list_items WHERE list_id = l.id) AS count,
            (SELECT COALESCE(s.poster_url, m.poster_url)
             FROM custom_list_items li
             LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
             LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
             WHERE li.list_id = l.id AND COALESCE(s.poster_url, m.poster_url) IS NOT NULL
             ORDER BY li.position LIMIT 1) AS poster
     FROM custom_lists l JOIN users u ON u.id = l.user_id
     WHERE l.id = ?1 AND u.username = ?2 AND l.is_shared = 1 AND u.deleted_at IS NULL`
  )
    .bind(id, username)
    .first<ListRow>();
  if (!row) return null;
  const owner = row.username;
  const noun = row.count === 1 ? "title" : "titles";
  const preamble = (row.preamble ?? "").trim();
  // Attribute the shared card to its owner in the title itself:
  // "<list name> by <owner>". HTMLRewriter escapes both the og:title/
  // twitter:title attribute and the <title> text, so the user-authored list
  // name is safe here as everywhere else in this file.
  const shareTitle = `${row.name} by ${owner}`;
  return {
    name: shareTitle,
    tab: shareTitle,
    // The owner's note when they wrote one, else attribution + size,
    // mirroring the app's own share text ("A list by <owner> on Show Us TV.").
    description: preamble ? clamp(preamble) : `A list by @${owner} — ${row.count} ${noun} on Show Us TV.`,
    ogType: "website", // Open Graph has no list/collection type
    url: origin + publicListPath(owner, id, row.name),
    // A representative poster (portrait → summary card); NULL leaves the landing
    // og.png tags in place for an empty or art-less list.
    image: row.poster
      ? {
          url: `${env.TMDB_IMG_BASE}/w500${row.poster}`,
          width: 500,
          height: 750,
          type: "image/jpeg",
          alt: `Cover art for the list ${row.name}`,
          card: "summary",
        }
      : null,
  };
}

function withYear(title: string, date: string | null): string {
  const year = /^\d{4}/.exec(date ?? "")?.[0];
  return year ? `${title} (${year})` : title;
}

function describe(overview: string | null, title: string): string {
  const text = (overview ?? "").trim();
  if (!text) return `Track ${title} on Show Us TV — air dates, watch progress, and full history.`;
  return clamp(text);
}

// Trim already-trimmed text to ≤300 chars on a word boundary, with an ellipsis.
function clamp(text: string): string {
  if (text.length <= 300) return text;
  const cut = text.slice(0, 299);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 200 ? lastSpace : 299).trimEnd()}…`;
}

// TMDB path fragments (e.g. "/abc.jpg") → absolute CDN URLs. Sizes follow
// what the app already uses (src/web/img.ts): w1280 backdrops are ~1280×720
// (TMDB backdrops are 16:9), w500 posters are 500×750 (2:3).
function artwork(env: Env, backdrop: string | null, poster: string | null, name: string): Artwork | null {
  if (backdrop) {
    return {
      url: `${env.TMDB_IMG_BASE}/w1280${backdrop}`,
      width: 1280,
      height: 720,
      type: "image/jpeg",
      alt: `Backdrop from ${name}`,
      card: "summary_large_image",
    };
  }
  if (poster) {
    return {
      url: `${env.TMDB_IMG_BASE}/w500${poster}`,
      width: 500,
      height: 750,
      type: "image/jpeg",
      alt: `Poster for ${name}`,
      card: "summary",
    };
  }
  return null;
}
