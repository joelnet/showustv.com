// Per-page social previews. `run_worker_first` sends /show/*, /movie/*, and
// /episode/* (issue #211) plus /u/* (issue #219) to the Worker, which serves
// the SPA shell with the <head> rewritten for that specific page so link
// unfurlers (Discord, Slack, iMessage, Twitter/X, Facebook) render the
// title's name, overview, and artwork — or a public profile's username —
// instead of the generic landing-page card. Real visitors get the same shell
// — the SPA hydrates regardless of what's in <head> — so there is no crawler
// user-agent sniffing to keep in sync.
//
// Security: TMDB-sourced text (titles, overviews) and usernames are injected
// exclusively through HTMLRewriter's setAttribute()/setInnerContent(), which
// HTML-escape their input. Nothing is string-concatenated into markup.
// Private profiles get the untouched landing shell — identical to an unknown
// username — so a preview can neither leak a private profile's data nor
// confirm that it exists.

import { mediaPath, type MediaType } from "../../web/paths";
import type { Env } from "../env";

// Only the leading digits identify the record; any "-slug" suffix is advisory
// (see src/web/paths.ts). Anchored: sub-paths like /show/123/x aren't title
// pages (the SPA route is exactly /show/:id) and must not get a title card.
const TITLE_PATH_RE = /^\/(show|movie|episode)\/(\d+)(?:-[^/]*)?\/?$/;

// Profile pages: exactly /u/:username (issue #219). The charset mirrors
// USERNAME_RE (src/worker/lib/username.ts) — anything else can't be a real
// username, and sub-paths like /u/:username/achievements or
// /u/:username/lists/:id keep the landing card.
const USER_PATH_RE = /^\/u\/([A-Za-z0-9_]{3,20})\/?$/;

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
    const user = title ? null : USER_PATH_RE.exec(url.pathname);
    const meta = title
      ? await lookupMeta(env, title[1] as MediaType, Number(title[2]), origin)
      : user
        ? await lookupUserMeta(env, user[1], origin)
        : null;
    // Unknown title (not in D1 yet), unknown username, private profile, or a
    // sub-path → generic landing card, byte-identical in every case.
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

// Public profile preview (issue #219). The ONE gate that matters is baked
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
  };
}

function withYear(title: string, date: string | null): string {
  const year = /^\d{4}/.exec(date ?? "")?.[0];
  return year ? `${title} (${year})` : title;
}

function describe(overview: string | null, title: string): string {
  const text = (overview ?? "").trim();
  if (!text) return `Track ${title} on Show Us TV — air dates, watch progress, and full history.`;
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
