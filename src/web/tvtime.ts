// TV Time GDPR-export zip parser. Runs entirely in the browser (fflate) so the
// server never sees the archive — only the distilled records we can import.
//
// The export format was never officially documented and has changed over the
// years, so parsing is deliberately liberal:
//   * files are classified by their COLUMNS first, filename second;
//   * many column-name variants are accepted for each field;
//   * malformed rows are counted and skipped, never fatal;
//   * everything we can't use is reported back with a reason.
//
// Known shapes we target (from the docs/ specs and community importers):
//   * seen_episode.csv           — tv_show_id (TVDB), episode_id (TVDB),
//                                  optional season/episode numbers, created_at
//   * followed_tv_show.csv       — tv_show_id, tv_show_name, created_at
//   * tracking-prod-records*.csv — mixed rows keyed by type/entity_type
//                                  (watch/watchlist/follow × episode/movie)
//                                  with series_id, season/episode numbers,
//                                  movie_name, dates. Rows without a positive
//                                  watch action (ratings, favorites,
//                                  reactions, …) are counted as unsupported,
//                                  never imported as watches.
//
// Timestamps: bare "YYYY-MM-DD HH:MM:SS" values are treated as UTC (TV Time
// stored UTC) and re-serialized as ISO 8601 with a trailing Z.

import { unzipSync, strFromU8 } from "fflate";

export interface EpisodeMark {
  season: number;
  number: number;
  watchedAt: string | null; // ISO 8601 UTC
}

export interface ShowGroup {
  key: string; // "tvdb:123" or "name:normalized title"
  tvdbId: number | null;
  name: string | null;
  followed: boolean;
  favorited: boolean; // starred in TV Time (user_tv_show_data / *_special_status)
  archived: boolean; // "archived" in TV Time (special_status) — imported as a stopped show
  episodes: EpisodeMark[]; // identified by season/number — importable directly
  episodeIds: { tvdbId: number; watchedAt: string | null }[]; // need TVDB→TMDB episode lookup
}

export interface MovieRec {
  name: string;
  year: number | null;
  watchedAt: string | null;
  watchlist: boolean;
}

export interface FileReport {
  name: string;
  kind: "episodes" | "follows" | "movies" | "mixed" | "favorites";
  rows: number;
  used: number;
  unsupported: number; // rows of non-watch record types (ratings, favorites, …)
  truncated: boolean; // file exceeded MAX_ROWS_PER_FILE; the overflow was ignored
}

export interface UnrecognizedFile {
  name: string;
  reason: string;
}

export interface ParseResult {
  shows: ShowGroup[];
  looseEpisodes: { tvdbId: number; watchedAt: string | null }[]; // no show reference at all
  movies: MovieRec[];
  files: FileReport[];
  unrecognized: UnrecognizedFile[];
  skippedRows: number; // malformed/unusable rows inside recognized files
  unsupportedRows: number; // rows of unsupported record types across recognized files
}

export const MAX_ZIP_BYTES = 100 << 20; // 100 MB archive
const MAX_FILE_BYTES = 30 << 20; // 30 MB per entry
const MAX_TOTAL_BYTES = 200 << 20; // 200 MB total expanded
const MAX_ROWS_PER_FILE = 250_000;

// ---------- tiny RFC 4180-ish CSV parser (quotes, embedded commas/newlines) ----------

function parseCsv(text: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };
  let i = 0;
  for (; i < text.length && rows.length <= maxRows; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") field += ch;
  }
  const truncated = i < text.length; // stopped at the row cap with input left over
  if (!truncated && (field !== "" || row.length)) endRow();
  return { rows, truncated };
}

// ---------- field extraction ----------

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
export const normTitle = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const ALIASES = {
  showTvdb: ["tv_show_id", "show_id", "series_id", "s_id", "tvdb_id", "tvdb_series_id", "show_tvdb_id"],
  showName: ["tv_show_name", "show_name", "series_name", "series_title", "show_title"],
  season: ["episode_season_number", "season_number", "season"],
  epNumber: ["episode_number", "episode_num", "number"],
  epCode: ["episode", "episode_code"], // may hold "S01E05"
  epTvdb: ["episode_id", "ep_id", "tvdb_episode_id", "episode_tvdb_id"],
  watchedAt: ["watched_at", "watch_date", "date_watched", "first_watched_at", "created_at", "created", "updated_at"],
  movieName: ["movie_name", "movie_title", "film_name"],
  releaseYear: ["release_year", "year"],
  releaseDate: ["release_date"],
  entityType: ["entity_type", "type", "kind"],
  genericName: ["name", "title"],
} as const;

type Cols = Map<string, number>;

function pick(cols: Cols, row: string[], names: readonly string[]): string | null {
  for (const n of names) {
    const i = cols.get(n);
    if (i != null) {
      const v = (row[i] ?? "").trim();
      if (v !== "" && v.toLowerCase() !== "null" && v.toLowerCase() !== "none") return v;
    }
  }
  return null;
}

function posInt(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegInt(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Liberal timestamp parser → ISO 8601 UTC or null.
function parseWhen(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  // Bare "YYYY-MM-DD[ HH:MM[:SS]]" — assume UTC (TV Time stored UTC).
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  let t: number;
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  } else {
    t = Date.parse(s);
  }
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  if (year < 1970 || year > 2100) return null; // garbage guard
  return new Date(t).toISOString();
}

// "S01E05"-style code → [season, number]
function parseEpCode(v: string | null): [number, number] | null {
  if (!v) return null;
  const m = /^s(\d{1,3})\s*[._x-]?\s*e(\d{1,4})$/i.exec(v.trim()) ?? /^(\d{1,3})x(\d{1,4})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ---------- file classification ----------

// Checked BEFORE column classification: these files may well contain
// episode_id/created_at columns but must not be mistaken for watch history.
const UNSUPPORTED: [RegExp, string][] = [
  [/comment/, "Comments can't be imported"],
  [/reaction|emotion|feeling|mood/, "Episode reactions can't be imported"],
  [/rating|rate/, "Ratings can't be imported"],
  [/friend|follower|^follow(ing|ers)?$|social|relationship|contact/, "Social connections can't be imported"],
  [/quiz|badge|poll|vote|notification|banner|reminder/, "App activity data isn't imported"],
  [/^(user|profile|account|preference|settings|device|session|login|auth)/, "Account and profile data isn't imported"],
  [/watch_?list|watch_?later/, "Watchlist import isn't supported yet"],
];

// Row-action vocabulary for mixed tracking files (tracking-prod-records*).
// Those files interleave many record types — watches, ratings, favorites,
// reactions — so a row only imports when it carries a positive watch action.
// WATCHLIST must be tested before WATCH ("watchlist" contains "watch").
const NEGATIVE_ACTION = /rat(e|ed|ing)|favou?rit|reaction|react|comment|emotion|feel|vote|like|share|pin|recommend|quiz|badge/;
const WATCHLIST_ACTION = /watch_?list|watch_?later|to_?watch|plan/;
const WATCH_ACTION = /watch|seen|view|track|histor|progress|check/;
const FOLLOW_ACTION = /follow/;

interface Ctx {
  groups: Map<string, ShowGroup & { epMap: Map<string, EpisodeMark>; epIdMap: Map<number, string | null> }>;
  loose: Map<number, string | null>;
  movies: Map<string, MovieRec>;
  skippedRows: number;
}

function groupFor(ctx: Ctx, tvdbId: number | null, name: string | null) {
  const key = tvdbId != null ? `tvdb:${tvdbId}` : `name:${normTitle(name!)}`;
  let g = ctx.groups.get(key);
  if (!g) {
    g = { key, tvdbId, name, followed: false, favorited: false, archived: false, episodes: [], episodeIds: [], epMap: new Map(), epIdMap: new Map() };
    ctx.groups.set(key, g);
  }
  if (g.name == null && name) g.name = name;
  return g;
}

const earliest = (a: string | null | undefined, b: string | null) => {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
};

// Returns true if the row was used.
function handleEpisodeRow(ctx: Ctx, cols: Cols, row: string[]): boolean {
  const tvdbId = posInt(pick(cols, row, ALIASES.showTvdb));
  const name = pick(cols, row, ALIASES.showName);
  const watchedAt = parseWhen(pick(cols, row, ALIASES.watchedAt));

  let season = nonNegInt(pick(cols, row, ALIASES.season));
  let number = posInt(pick(cols, row, ALIASES.epNumber));
  if (season == null || number == null) {
    const code = parseEpCode(pick(cols, row, ALIASES.epCode)) ?? parseEpCode(pick(cols, row, ALIASES.epNumber));
    if (code) [season, number] = code;
  }
  const epTvdb = posInt(pick(cols, row, ALIASES.epTvdb));

  if ((tvdbId != null || name) && season != null && number != null) {
    const g = groupFor(ctx, tvdbId, name);
    const k = `${season}:${number}`;
    const prev = g.epMap.get(k);
    g.epMap.set(k, { season, number, watchedAt: prev ? earliest(prev.watchedAt, watchedAt) : watchedAt });
    return true;
  }
  if (epTvdb != null) {
    // No usable season/number — fall back to per-episode TVDB id resolution.
    if (tvdbId != null || name) {
      const g = groupFor(ctx, tvdbId, name);
      g.epIdMap.set(epTvdb, earliest(g.epIdMap.get(epTvdb), watchedAt));
    } else {
      ctx.loose.set(epTvdb, earliest(ctx.loose.get(epTvdb), watchedAt));
    }
    return true;
  }
  return false;
}

function handleFollowRow(ctx: Ctx, cols: Cols, row: string[]): boolean {
  const tvdbId = posInt(pick(cols, row, ALIASES.showTvdb));
  const name = pick(cols, row, ALIASES.showName) ?? pick(cols, row, ALIASES.genericName);
  if (tvdbId == null && !name) return false;
  groupFor(ctx, tvdbId, name).followed = true;
  return true;
}

function handleFavoriteRow(ctx: Ctx, cols: Cols, row: string[]): boolean {
  const tvdbId = posInt(pick(cols, row, ALIASES.showTvdb));
  const name = pick(cols, row, ALIASES.showName) ?? pick(cols, row, ALIASES.genericName);
  if (tvdbId == null && !name) return false;
  groupFor(ctx, tvdbId, name).favorited = true;
  return true;
}

function handleArchivedRow(ctx: Ctx, cols: Cols, row: string[]): boolean {
  const tvdbId = posInt(pick(cols, row, ALIASES.showTvdb));
  const name = pick(cols, row, ALIASES.showName) ?? pick(cols, row, ALIASES.genericName);
  if (tvdbId == null && !name) return false;
  groupFor(ctx, tvdbId, name).archived = true;
  return true;
}

function handleMovieRow(ctx: Ctx, cols: Cols, row: string[], watchlist: boolean): boolean {
  const name = pick(cols, row, ALIASES.movieName) ?? pick(cols, row, ALIASES.genericName);
  if (!name) return false;
  const year =
    posInt(pick(cols, row, ALIASES.releaseYear)) ??
    posInt((pick(cols, row, ALIASES.releaseDate) ?? "").slice(0, 4) || null);
  const watchedAt = parseWhen(pick(cols, row, ALIASES.watchedAt));
  const k = `${normTitle(name)}:${year ?? ""}`;
  const prev = ctx.movies.get(k);
  if (prev) {
    prev.watchedAt = earliest(prev.watchedAt, watchedAt);
    prev.watchlist = prev.watchlist && watchlist; // watched wins over watchlist
  } else {
    ctx.movies.set(k, { name, year, watchedAt, watchlist });
  }
  return true;
}

// ---------- top level ----------

export function parseTvTimeZip(data: Uint8Array): ParseResult {
  if (data.length > MAX_ZIP_BYTES) throw new Error("Archive is too large (max 100 MB).");

  const unrecognized: UnrecognizedFile[] = [];
  let totalBytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/") || f.name.includes("__MACOSX")) return false;
        const short = f.name.split("/").pop() ?? f.name;
        if (short.startsWith(".")) return false;
        if (!/\.(csv|txt)$/i.test(short)) {
          unrecognized.push({ name: f.name, reason: "Unsupported file type (only CSV is understood)" });
          return false;
        }
        if (f.originalSize > MAX_FILE_BYTES) {
          unrecognized.push({ name: f.name, reason: "File too large to parse in the browser" });
          return false;
        }
        totalBytes += f.originalSize;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Archive expands too large to parse safely.");
        return true;
      },
    });
  } catch (e: any) {
    throw new Error(e?.message?.includes("too large") ? e.message : "That file doesn't look like a valid zip archive.");
  }

  const names = Object.keys(entries);
  if (names.length === 0 && unrecognized.length === 0) throw new Error("The archive is empty.");

  const ctx: Ctx = { groups: new Map(), loose: new Map(), movies: new Map(), skippedRows: 0 };
  const files: FileReport[] = [];

  for (const name of names.sort()) {
    const base = normHeader((name.split("/").pop() ?? name).replace(/\.(csv|txt)$/i, ""));

    // Favorites live in user_*/status files the account-data filter below
    // would otherwise skip (issue #21) — let those through to column
    // classification, which confirms the favorite shape before using them.
    const looksFavorites = /favou?rite|special_status|tv_show_data/.test(base);
    const unsupported = looksFavorites ? undefined : UNSUPPORTED.find(([re]) => re.test(base));
    if (unsupported) {
      unrecognized.push({ name, reason: unsupported[1] });
      continue;
    }

    let rows: string[][];
    let truncated: boolean;
    try {
      ({ rows, truncated } = parseCsv(strFromU8(entries[name]), MAX_ROWS_PER_FILE));
    } catch {
      unrecognized.push({ name, reason: "Couldn't decode file contents" });
      continue;
    }
    if (rows.length < 2) {
      unrecognized.push({ name, reason: "No data rows" });
      continue;
    }

    const header = rows[0].map(normHeader);
    const cols: Cols = new Map(header.map((h, i) => [h, i]));
    const has = (names: readonly string[]) => names.some((n) => cols.has(n));

    // Classify by columns; the filename is only a hint.
    const hasEpisodeShape = has(ALIASES.epTvdb) || has(ALIASES.epCode) || (has(ALIASES.season) && has(ALIASES.epNumber));
    const hasMovieShape = has(ALIASES.movieName) || /movie|film/.test(base);
    const hasShowShape = has(ALIASES.showTvdb) || has(ALIASES.showName);
    const hasEntityType = has(ALIASES.entityType);
    // Show-level favorite flags: an explicit is_favorited column, or the
    // per-show special-status file (user_show_special_status: status =
    // 'favorite'). The status heuristic is scoped to that file by name — a
    // generic show CSV can carry a lifecycle `status` (Ended/Running) and must
    // still classify as follows, not favorites.
    const hasFavoriteShape = cols.has("is_favorited") || (cols.has("status") && /special_status|favou?rite/.test(base));

    let kind: FileReport["kind"];
    if (hasFavoriteShape) kind = "favorites";
    else if (hasEntityType && (hasEpisodeShape || hasMovieShape)) kind = "mixed";
    else if (hasEpisodeShape && hasShowShape) kind = "episodes";
    else if (hasEpisodeShape) kind = "episodes"; // episode ids only — resolvable per-id
    else if (hasMovieShape) kind = "movies";
    else if (hasShowShape) kind = "follows";
    else {
      unrecognized.push({ name, reason: "Unrecognized columns — nothing importable found" });
      continue;
    }

    let used = 0;
    let unsupportedRows = 0;
    for (const row of rows.slice(1)) {
      let ok = false;
      if (kind === "mixed") {
        // Concatenate every type-ish column: v1 tracking files carry both
        // type=watch|watchlist AND entity_type=movie on the same row.
        const t = ALIASES.entityType
          .map((n) => {
            const i = cols.get(n);
            return i != null ? (row[i] ?? "") : "";
          })
          .join(" ")
          .toLowerCase();
        const isMovie = t.includes("movie") || t.includes("film");
        // Only rows with an explicit watch/watchlist/follow action import;
        // ratings, favorites, reactions etc. are counted, not imported.
        if (NEGATIVE_ACTION.test(t)) {
          unsupportedRows++;
          continue;
        } else if (FOLLOW_ACTION.test(t)) {
          ok = handleFollowRow(ctx, cols, row);
        } else if (WATCHLIST_ACTION.test(t)) {
          if (!isMovie) {
            unsupportedRows++; // show watchlist rows aren't supported yet
            continue;
          }
          ok = handleMovieRow(ctx, cols, row, true);
        } else if (WATCH_ACTION.test(t)) {
          ok = isMovie ? handleMovieRow(ctx, cols, row, false) : handleEpisodeRow(ctx, cols, row);
        } else {
          unsupportedRows++; // no positive watch action — don't guess
          continue;
        }
      } else if (kind === "favorites") {
        // Per-show flag rows: is_favorited / is_followed columns, or a
        // status = 'favorite' / 'archived' marker. A row flagging none of
        // those is counted but not imported.
        const fav = pick(cols, row, ["is_favorited"]);
        const status = (pick(cols, row, ["status"]) ?? "").toLowerCase();
        const foll = pick(cols, row, ["is_followed"]);
        const isFav = fav === "1" || fav === "true" || status.includes("favo"); // favorite / favourite
        const isFoll = foll === "1" || foll === "true";
        const isArchived = status.includes("archiv"); // archived → stopped watching
        if (!isFav && !isFoll && !isArchived) {
          unsupportedRows++;
          continue;
        }
        if (isFav) ok = handleFavoriteRow(ctx, cols, row);
        if (isFoll) ok = handleFollowRow(ctx, cols, row) || ok;
        if (isArchived) ok = handleArchivedRow(ctx, cols, row) || ok;
      } else if (kind === "episodes") {
        ok = handleEpisodeRow(ctx, cols, row);
      } else if (kind === "movies") {
        ok = handleMovieRow(ctx, cols, row, /watch_?list|watch_?later|to_watch/.test(base));
      } else {
        ok = handleFollowRow(ctx, cols, row);
      }
      if (ok) used++;
      else ctx.skippedRows++;
    }
    files.push({ name, kind, rows: rows.length - 1, used, unsupported: unsupportedRows, truncated });
  }

  const shows: ShowGroup[] = [...ctx.groups.values()].map((g) => ({
    key: g.key,
    tvdbId: g.tvdbId,
    name: g.name,
    followed: g.followed,
    favorited: g.favorited,
    archived: g.archived,
    episodes: [...g.epMap.values()].sort((a, b) => a.season - b.season || a.number - b.number),
    episodeIds: [...g.epIdMap.entries()].map(([tvdbId, watchedAt]) => ({ tvdbId, watchedAt })),
  }));

  return {
    shows,
    looseEpisodes: [...ctx.loose.entries()].map(([tvdbId, watchedAt]) => ({ tvdbId, watchedAt })),
    movies: [...ctx.movies.values()],
    files,
    unrecognized,
    skippedRows: ctx.skippedRows,
    unsupportedRows: files.reduce((n, f) => n + f.unsupported, 0),
  };
}
