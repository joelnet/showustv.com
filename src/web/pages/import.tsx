// TV Time import. The zip is parsed entirely in the browser (src/web/tvtime.ts);
// the server only sees small resolve/import batches. Flow:
//   pick file → parse → resolve against TMDB (progress) → preview of what can
//   and cannot be imported → confirm → batched import (progress) → summary.

import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api";
import { useOffline } from "../offline";
import { precacheLibrary } from "../precache";
import { Empty } from "../components/ui";
import { parseTvTimeZip, MAX_ZIP_BYTES, type EpisodeMark, type MovieRec, type ParseResult } from "../tvtime";

const RESOLVE_SHOW_BATCH = 40;
const RESOLVE_EPISODE_BATCH = 40;
const RESOLVE_MOVIE_BATCH = 20;
const IMPORT_EPISODE_BATCH = 400;
const IMPORT_MOVIE_BATCH = 20;
const IMPORT_FAVORITE_BATCH = 100;
const IMPORT_ARCHIVED_BATCH = 100;
const IMPORT_CONCURRENCY = 2;

interface Match {
  tmdbId: number;
  title: string;
  poster: string | null;
}

interface ResolvedGroup {
  key: string;
  tvdbId: number | null;
  name: string | null; // as it appeared in the export
  match: Match | null;
  method: string | null;
  followed: boolean;
  favorited: boolean;
  archived: boolean;
  episodes: EpisodeMark[];
  unresolvedIds: number; // TVDB episode ids TMDB couldn't place
}

interface ResolvedMovie extends MovieRec {
  match: Match | null;
}

interface Progress {
  done: number;
  total: number;
  label: string;
}

interface GroupOutcome {
  title: string;
  followed: boolean;
  inserted: number;
  existing: number;
  notFound: { season: number; number: number }[];
  error: string | null;
}

interface ImportOutcome {
  groups: GroupOutcome[];
  movies: { inserted: number; existing: number; failed: number };
  favorites: { added: number; existing: number; failed: number };
  archived: { updated: number; failed: number };
}

type Stage =
  | { name: "pick"; error?: string }
  | { name: "busy"; verb: string; progress: Progress | null }
  | { name: "preview"; parsed: ParseResult; groups: ResolvedGroup[]; movies: ResolvedMovie[]; looseUnresolved: number }
  | { name: "done"; outcome: ImportOutcome };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export function ImportPage() {
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  const { online } = useOffline();
  const fileRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);

  // Import resolves every show/episode against TMDB — it genuinely needs
  // the network, so don't let anyone start one offline.
  if (!online && stage.name === "pick") {
    return (
      <div className="import-page">
        <h1 className="page-title">Import from TV Time</h1>
        <Empty title="You're offline" hint="Importing matches your export against TMDB, which needs a connection. Come back online and try again." />
      </div>
    );
  }

  async function handleFile(file: File) {
    // Size gate BEFORE reading: pulling a multi-GB file into an ArrayBuffer
    // would freeze the tab long before the parser's own cap could fire.
    if (file.size > MAX_ZIP_BYTES) {
      setStage({ name: "pick", error: "That file is too large (max 100 MB)." });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setStage({ name: "busy", verb: "Reading archive", progress: null });
    try {
      const parsed = parseTvTimeZip(new Uint8Array(await file.arrayBuffer()));
      const { groups, movies, looseUnresolved } = await resolveAll(parsed, (p) =>
        setStage({ name: "busy", verb: "Matching against TMDB", progress: p })
      );
      setStage({ name: "preview", parsed, groups, movies, looseUnresolved });
    } catch (e: any) {
      setStage({ name: "pick", error: e?.message ?? "Couldn't read that file." });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runImport(groups: ResolvedGroup[], movies: ResolvedMovie[]) {
    // Synchronous in-flight guard: a double-click must not start two imports
    // (state updates are async, so the stage flip alone can't prevent it).
    if (importingRef.current) return;
    importingRef.current = true;
    try {
      setStage({ name: "busy", verb: "Importing", progress: null });
      const outcome = await importAll(groups, movies, (p) => setStage({ name: "busy", verb: "Importing", progress: p }));
      setStage({ name: "done", outcome });
      // The library just grew by (possibly) hundreds of titles the boot-time
      // pass never saw — warm them for offline now (issue #183). Fresh
      // indexes (the cached ones predate the import); already-cached titles
      // are skipped, so this only fetches what the import added.
      precacheLibrary(true);
    } finally {
      importingRef.current = false;
    }
  }

  return (
    <div className="import-page">
      <h1 className="page-title">Import from TV Time</h1>

      {stage.name === "pick" && (
        <>
          <p className="settings-hint">
            Upload the zip archive from TV Time&rsquo;s{" "}
            <a href="https://gdpr.tvtime.com/gdpr/self-service" target="_blank" rel="noreferrer">
              GDPR data export
            </a>
            . It&rsquo;s unpacked right here in your browser: only the shows, episodes and movies we can match are
            sent to the server. You&rsquo;ll see a preview before anything is imported, and re-running an import never
            duplicates history.
          </p>
          {stage.error && <p className="error-note">{stage.error}</p>}
          <label className="btn import-file-btn">
            Choose zip file…
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </label>
        </>
      )}

      {stage.name === "busy" && <Busy verb={stage.verb} progress={stage.progress} />}

      {stage.name === "preview" && (
        <Preview
          parsed={stage.parsed}
          groups={stage.groups}
          movies={stage.movies}
          looseUnresolved={stage.looseUnresolved}
          onConfirm={() => runImport(stage.groups, stage.movies)}
          onCancel={() => setStage({ name: "pick" })}
        />
      )}

      {stage.name === "done" && <Summary outcome={stage.outcome} />}
    </div>
  );
}

// ---------- resolution ----------

// Exported (with importAll) so the pipeline can be exercised outside React.
export async function resolveAll(parsed: ParseResult, onProgress: (p: Progress) => void) {
  const epIdCount = parsed.shows.reduce((n, g) => n + g.episodeIds.length, 0) + parsed.looseEpisodes.length;
  const total =
    Math.ceil(parsed.shows.length / RESOLVE_SHOW_BATCH) +
    Math.ceil(epIdCount / RESOLVE_EPISODE_BATCH) +
    Math.ceil(parsed.movies.length / RESOLVE_MOVIE_BATCH);
  let done = 0;
  const tick = (label: string) => onProgress({ done: ++done, total, label });

  // 1. Shows: TVDB id (exact) or title (exact-match only) → TMDB.
  const groups: ResolvedGroup[] = [];
  const epMaps = new Map<string, Map<string, EpisodeMark>>();
  for (const batch of chunk(parsed.shows, RESOLVE_SHOW_BATCH)) {
    const r = await post("/import/resolve", { shows: batch.map((g) => ({ tvdbId: g.tvdbId, name: g.name })) });
    batch.forEach((g, i) => {
      const res = r.shows[i] ?? { match: null, method: null };
      groups.push({
        key: g.key,
        tvdbId: g.tvdbId,
        name: g.name,
        match: res.match,
        method: res.method,
        followed: g.followed,
        favorited: g.favorited,
        archived: g.archived,
        episodes: [],
        unresolvedIds: 0,
      });
      epMaps.set(g.key, new Map(g.episodes.map((e) => [`${e.season}:${e.number}`, e])));
    });
    tick("Matching shows");
  }
  const byTmdb = new Map<number, ResolvedGroup>();
  for (const g of groups) if (g.match && !byTmdb.has(g.match.tmdbId)) byTmdb.set(g.match.tmdbId, g);

  // 2. Old-format rows carry only a TVDB *episode* id — resolve each via the
  //    server (TMDB /find) into show/season/number.
  let looseUnresolved = 0;
  const idRecords: { tvdbId: number; watchedAt: string | null; origin: ResolvedGroup | null }[] = [
    ...parsed.shows.flatMap((g, i) => g.episodeIds.map((e) => ({ ...e, origin: groups[i] }))),
    ...parsed.looseEpisodes.map((e) => ({ ...e, origin: null })),
  ];
  const attach = (g: ResolvedGroup, mark: EpisodeMark) => {
    let m = epMaps.get(g.key);
    if (!m) epMaps.set(g.key, (m = new Map()));
    const k = `${mark.season}:${mark.number}`;
    const prev = m.get(k);
    if (!prev || (mark.watchedAt && (!prev.watchedAt || mark.watchedAt < prev.watchedAt))) m.set(k, mark);
  };
  for (const batch of chunk(idRecords, RESOLVE_EPISODE_BATCH)) {
    const r = await post("/import/resolve-episodes", { ids: batch.map((b) => b.tvdbId) });
    for (const rec of batch) {
      const hit = r.results[rec.tvdbId];
      // Unresolvable — or resolved to a DIFFERENT show than the export claimed
      // (a stale/reused TVDB id): don't silently import an unrelated show.
      if (!hit || (rec.origin?.match && rec.origin.match.tmdbId !== hit.show)) {
        if (rec.origin) rec.origin.unresolvedIds++;
        else looseUnresolved++;
        continue;
      }
      let g = byTmdb.get(hit.show) ?? (rec.origin?.match ? rec.origin : null);
      if (!g) {
        g = {
          key: `tmdb:${hit.show}`,
          tvdbId: null,
          name: rec.origin?.name ?? null,
          match: { tmdbId: hit.show, title: rec.origin?.name ?? `TMDB show #${hit.show}`, poster: null },
          method: "episode",
          followed: false,
          favorited: false,
          archived: false,
          episodes: [],
          unresolvedIds: 0,
        };
        groups.push(g);
        byTmdb.set(hit.show, g);
      }
      attach(g, { season: hit.season, number: hit.number, watchedAt: rec.watchedAt });
    }
    tick("Matching episodes");
  }
  for (const g of groups) {
    const m = epMaps.get(g.key);
    if (m) g.episodes = [...m.values()].sort((a, b) => a.season - b.season || a.number - b.number);
  }

  // 3. Movies: exact-title (+year) match only.
  const movies: ResolvedMovie[] = [];
  for (const batch of chunk(parsed.movies, RESOLVE_MOVIE_BATCH)) {
    const r = await post("/import/resolve", { movies: batch.map((m) => ({ name: m.name, year: m.year })) });
    batch.forEach((m, i) => movies.push({ ...m, match: r.movies[i]?.match ?? null }));
    tick("Matching movies");
  }

  return { groups, movies, looseUnresolved };
}

// ---------- import ----------

export async function importAll(
  groups: ResolvedGroup[],
  movies: ResolvedMovie[],
  onProgress: (p: Progress) => void
): Promise<ImportOutcome> {
  const importable = groups.filter((g) => g.match && (g.followed || g.episodes.length > 0));
  const movieRecs = movies.filter((m) => m.match);
  const favoriteIds = groups.filter((g) => g.match && g.favorited).map((g) => g.match!.tmdbId);
  const archivedIds = groups.filter((g) => g.match && g.archived).map((g) => g.match!.tmdbId);
  const total =
    importable.length +
    Math.ceil(movieRecs.length / IMPORT_MOVIE_BATCH) +
    Math.ceil(favoriteIds.length / IMPORT_FAVORITE_BATCH) +
    Math.ceil(archivedIds.length / IMPORT_ARCHIVED_BATCH);
  let done = 0;

  const outcomes: GroupOutcome[] = [];
  await pool(importable, IMPORT_CONCURRENCY, async (g) => {
    const out: GroupOutcome = {
      title: g.match!.title,
      followed: g.followed,
      inserted: 0,
      existing: 0,
      notFound: [],
      error: null,
    };
    onProgress({ done, total, label: g.match!.title });
    try {
      // First call also creates the follow; episode batches keep order.
      const batches = g.episodes.length ? chunk(g.episodes, IMPORT_EPISODE_BATCH) : [[] as EpisodeMark[]];
      for (const eps of batches) {
        const r = await post(`/import/shows/${g.match!.tmdbId}/episodes`, { episodes: eps });
        out.inserted += r.inserted;
        out.existing += r.existing;
        out.notFound.push(...r.notFound);
      }
    } catch (e: any) {
      out.error = e?.message ?? "import failed";
    }
    // Retry pass: TVDB numbering runs past TMDB's wherever TVDB splits a
    // two-part episode, so marks the catalog rejected are re-resolved by
    // their TVDB episode id and imported at their real TMDB position. Only
    // same-show resolutions are trusted (a reused id must not mark another
    // show), and any failure here just leaves the original report standing.
    if (!out.error && out.notFound.length > 0) {
      try {
        const marks = new Map(g.episodes.map((e) => [`${e.season}:${e.number}`, e]));
        const retry = out.notFound
          .map((nf) => marks.get(`${nf.season}:${nf.number}`))
          .filter((e): e is EpisodeMark => e?.tvdbId != null);
        const recovered = new Set<string>();
        const resolved: EpisodeMark[] = [];
        for (const batch of chunk(retry, RESOLVE_EPISODE_BATCH)) {
          const r = await post("/import/resolve-episodes", { ids: batch.map((e) => e.tvdbId) });
          for (const e of batch) {
            const hit = r.results[e.tvdbId!];
            if (!hit || hit.show !== g.match!.tmdbId) continue;
            resolved.push({ season: hit.season, number: hit.number, watchedAt: e.watchedAt });
            recovered.add(`${e.season}:${e.number}`);
          }
        }
        for (const eps of chunk(resolved, IMPORT_EPISODE_BATCH)) {
          const r = await post(`/import/shows/${g.match!.tmdbId}/episodes`, { episodes: eps });
          out.inserted += r.inserted;
          out.existing += r.existing;
          out.notFound.push(...r.notFound);
        }
        if (recovered.size > 0) out.notFound = out.notFound.filter((nf) => !recovered.has(`${nf.season}:${nf.number}`));
      } catch {
        // resolve hiccup — the original notFound entries still tell the story
      }
    }
    outcomes.push(out);
    onProgress({ done: ++done, total, label: g.match!.title });
  });
  outcomes.sort((a, b) => a.title.localeCompare(b.title));

  const movieTotals = { inserted: 0, existing: 0, failed: 0 };
  for (const batch of chunk(movieRecs, IMPORT_MOVIE_BATCH)) {
    onProgress({ done, total, label: "Movies" });
    try {
      const r = await post("/import/movies", {
        movies: batch.map((m) => ({ tmdbId: m.match!.tmdbId, watchedAt: m.watchedAt, watchlist: m.watchlist })),
      });
      movieTotals.inserted += r.inserted;
      movieTotals.existing += r.existing;
      movieTotals.failed += r.failed.length;
    } catch {
      movieTotals.failed += batch.length;
    }
    onProgress({ done: ++done, total, label: "Movies" });
  }

  const favoriteTotals = { added: 0, existing: 0, failed: 0 };
  for (const batch of chunk(favoriteIds, IMPORT_FAVORITE_BATCH)) {
    onProgress({ done, total, label: "Favorites" });
    try {
      const r = await post("/import/favorites", { shows: batch });
      favoriteTotals.added += r.added;
      favoriteTotals.existing += r.existing;
      favoriteTotals.failed += r.failed.length;
    } catch {
      favoriteTotals.failed += batch.length;
    }
    onProgress({ done: ++done, total, label: "Favorites" });
  }

  // Archived shows last, so state = 'stopped' wins over the 'watching' the
  // episode import set for any archived show that also had watch history.
  const archivedTotals = { updated: 0, failed: 0 };
  for (const batch of chunk(archivedIds, IMPORT_ARCHIVED_BATCH)) {
    onProgress({ done, total, label: "Stopped shows" });
    try {
      const r = await post("/import/shows/archived", { shows: batch });
      archivedTotals.updated += r.updated;
      archivedTotals.failed += r.failed.length;
    } catch {
      archivedTotals.failed += batch.length;
    }
    onProgress({ done: ++done, total, label: "Stopped shows" });
  }

  return { groups: outcomes, movies: movieTotals, favorites: favoriteTotals, archived: archivedTotals };
}

// ---------- views ----------

function Busy({ verb, progress }: { verb: string; progress: Progress | null }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="import-busy" role="status">
      <p>
        {verb}
        {progress ? `: ${progress.label}` : "…"}
      </p>
      <div className="progress" aria-hidden={pct == null}>
        <div className="progress-fill" style={{ width: `${pct ?? 5}%` }} />
      </div>
      {pct != null && (
        <p className="settings-hint">
          {progress!.done} of {progress!.total} steps
        </p>
      )}
      <p className="settings-hint">Keep this tab open until the import finishes.</p>
    </div>
  );
}

function Preview({
  parsed,
  groups,
  movies,
  looseUnresolved,
  onConfirm,
  onCancel,
}: {
  parsed: ParseResult;
  groups: ResolvedGroup[];
  movies: ResolvedMovie[];
  looseUnresolved: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const matched = groups.filter((g) => g.match && (g.followed || g.episodes.length > 0));
  const unmatched = groups.filter((g) => !g.match);
  const episodeCount = matched.reduce((n, g) => n + g.episodes.length, 0);
  const followCount = matched.filter((g) => g.followed).length;
  const favoriteCount = groups.filter((g) => g.match && g.favorited).length;
  const archivedCount = groups.filter((g) => g.match && g.archived).length;
  const matchedMovies = movies.filter((m) => m.match);
  const unmatchedMovies = movies.filter((m) => !m.match);
  const unresolvedEpisodes = groups.reduce((n, g) => n + g.unresolvedIds, 0) + looseUnresolved;
  const truncatedFiles = parsed.files.filter((f) => f.truncated);
  const nothing = matched.length === 0 && matchedMovies.length === 0 && favoriteCount === 0 && archivedCount === 0;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="import-preview">
      <section className="import-block import-block-ok">
        <h2>Will be imported</h2>
        {nothing ? (
          <p>Nothing in this archive could be matched for import.</p>
        ) : (
          <ul>
            {followCount > 0 && <li>{plural(followCount, "show")} will be followed</li>}
            {favoriteCount > 0 && <li>{plural(favoriteCount, "show")} added to your favorites</li>}
            {archivedCount > 0 && <li>{plural(archivedCount, "archived show")} marked as stopped watching</li>}
            {episodeCount > 0 && (
              <li>
                {plural(episodeCount, "watched episode")} across {plural(matched.filter((g) => g.episodes.length > 0).length, "show")}, with their original watch dates
              </li>
            )}
            {matchedMovies.length > 0 && (
              <li>
                {plural(matchedMovies.filter((m) => !m.watchlist).length, "watched movie")}
                {matchedMovies.some((m) => m.watchlist) &&
                  `, ${plural(matchedMovies.filter((m) => m.watchlist).length, "watchlist movie")}`}
              </li>
            )}
          </ul>
        )}
        {matched.length > 0 && (
          <details>
            <summary>Show matched titles ({matched.length})</summary>
            <ul className="import-detail-list">
              {matched.map((g) => (
                <li key={g.key}>
                  {g.match!.title}
                  {g.episodes.length > 0 && <span className="import-dim"> ({plural(g.episodes.length, "episode")})</span>}
                  {g.method === "name" && <span className="import-dim"> (matched by title)</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {matchedMovies.length > 0 && (
          <details>
            <summary>Show matched movies ({matchedMovies.length})</summary>
            <ul className="import-detail-list">
              {matchedMovies.map((m, i) => (
                <li key={i}>
                  {m.match!.title}
                  {m.watchlist && <span className="import-dim"> (watchlist)</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="import-block import-block-warn">
        <h2>Can&rsquo;t be imported</h2>
        {unmatched.length === 0 &&
        unresolvedEpisodes === 0 &&
        unmatchedMovies.length === 0 &&
        parsed.unrecognized.length === 0 &&
        parsed.skippedRows === 0 &&
        parsed.unsupportedRows === 0 &&
        truncatedFiles.length === 0 ? (
          <p>Everything in the archive was recognized. Nice.</p>
        ) : (
          <ul>
            {unmatched.length > 0 && (
              <li>
                {plural(unmatched.length, "show")} with no confident TMDB match
                <ul className="import-detail-list">
                  {unmatched.map((g) => (
                    <li key={g.key}>
                      {g.name ?? (g.tvdbId != null ? `TVDB #${g.tvdbId}` : "unknown show")}
                      <span className="import-dim">
                        {" "}
                        ({g.episodes.length + g.unresolvedIds > 0
                          ? `${plural(g.episodes.length + g.unresolvedIds, "episode")} skipped`
                          : "follow skipped"})
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {unresolvedEpisodes > 0 && (
              <li>{plural(unresolvedEpisodes, "episode record")} whose TVDB episode id couldn&rsquo;t be confidently matched on TMDB</li>
            )}
            {unmatchedMovies.length > 0 && (
              <li>
                {plural(unmatchedMovies.length, "movie")} with no confident TMDB match
                <ul className="import-detail-list">
                  {unmatchedMovies.map((m, i) => (
                    <li key={i}>
                      {m.name}
                      {m.year != null && <span className="import-dim"> ({m.year})</span>}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {parsed.unrecognized.length > 0 && (
              <li>
                {plural(parsed.unrecognized.length, "file")} in the archive can&rsquo;t be used
                <ul className="import-detail-list">
                  {parsed.unrecognized.map((f) => (
                    <li key={f.name}>
                      {f.name} <span className="import-dim">({f.reason})</span>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {parsed.unsupportedRows > 0 && (
              <li>
                {plural(parsed.unsupportedRows, "row")} of other record types (ratings, reactions, …)
                aren&rsquo;t importable
              </li>
            )}
            {truncatedFiles.length > 0 && (
              <li>
                {plural(truncatedFiles.length, "file")} too large: rows beyond the first 250,000 were ignored
                <ul className="import-detail-list">
                  {truncatedFiles.map((f) => (
                    <li key={f.name}>{f.name}</li>
                  ))}
                </ul>
              </li>
            )}
            {parsed.skippedRows > 0 && <li>{plural(parsed.skippedRows, "malformed row")} skipped while parsing</li>}
          </ul>
        )}
      </section>

      <div className="import-actions">
        <button
          className="btn"
          onClick={() => {
            setConfirming(true); // disable immediately; the parent also holds a ref guard
            onConfirm();
          }}
          disabled={nothing || confirming}
        >
          Import {plural(followCount + episodeCount + matchedMovies.length + favoriteCount + archivedCount, "item")}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Summary({ outcome }: { outcome: ImportOutcome }) {
  const inserted = outcome.groups.reduce((n, g) => n + g.inserted, 0);
  const existing = outcome.groups.reduce((n, g) => n + g.existing, 0);
  const notFound = outcome.groups.reduce((n, g) => n + g.notFound.length, 0);
  const failed = outcome.groups.filter((g) => g.error);
  const ok = outcome.groups.filter((g) => !g.error);
  const m = outcome.movies;

  return (
    <div className="import-preview">
      <section className="import-block import-block-ok">
        <h2>Import complete</h2>
        <ul>
          <li>{plural(ok.length, "show")} followed or updated</li>
          <li>{plural(inserted, "episode")} marked watched</li>
          {existing > 0 && <li>{plural(existing, "episode")} were already in your history (left untouched)</li>}
          {(m.inserted > 0 || m.existing > 0) && (
            <li>
              {plural(m.inserted, "movie")} imported
              {m.existing > 0 && `, ${m.existing} already tracked`}
            </li>
          )}
          {(outcome.favorites.added > 0 || outcome.favorites.existing > 0) && (
            <li>
              {plural(outcome.favorites.added, "show")} added to favorites
              {outcome.favorites.existing > 0 && `, ${outcome.favorites.existing} already there`}
            </li>
          )}
          {outcome.archived.updated > 0 && (
            <li>{plural(outcome.archived.updated, "archived show")} marked as stopped watching</li>
          )}
        </ul>
      </section>

      {(notFound > 0 || failed.length > 0 || m.failed > 0 || outcome.favorites.failed > 0 || outcome.archived.failed > 0) && (
        <section className="import-block import-block-warn">
          <h2>Skipped</h2>
          <ul>
            {notFound > 0 && (
              <li>
                {plural(notFound, "episode")} not in TMDB&rsquo;s listings
                <ul className="import-detail-list">
                  {outcome.groups
                    .filter((g) => g.notFound.length > 0)
                    .map((g) => (
                      <li key={g.title}>
                        {g.title}
                        <span className="import-dim">
                          {" "}
                          ({g.notFound
                            .slice(0, 12)
                            .map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.number).padStart(2, "0")}`)
                            .join(", ")}
                          {g.notFound.length > 12 && ` and ${g.notFound.length - 12} more`})
                        </span>
                      </li>
                    ))}
                </ul>
              </li>
            )}
            {failed.length > 0 && (
              <li>
                {plural(failed.length, "show")} failed to import
                <ul className="import-detail-list">
                  {failed.map((g) => (
                    <li key={g.title}>
                      {g.title} <span className="import-dim">({g.error})</span>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {m.failed > 0 && <li>{plural(m.failed, "movie")} failed to import</li>}
            {outcome.favorites.failed > 0 && <li>{plural(outcome.favorites.failed, "favorite")} failed to import</li>}
            {outcome.archived.failed > 0 && <li>{plural(outcome.archived.failed, "archived show")} failed to import</li>}
          </ul>
        </section>
      )}

      <div className="import-actions">
        <Link className="btn" to="/library">
          Go to your library
        </Link>
        <Link className="btn btn-ghost" to="/settings">
          Back to settings
        </Link>
      </div>
    </div>
  );
}
