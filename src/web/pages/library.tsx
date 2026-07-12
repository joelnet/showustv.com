import { useState, type ReactElement } from "react";
import { NavLink } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { PosterCard, Progress, Empty, ErrorNote } from "../components/ui";
import { PosterGridSkeleton } from "../components/skeleton";
import { mediaPath } from "../paths";

// The Library's tabs partition every tracked show. "Watching" (issue #253) is
// tracked shows that are not up to date, not finished, and not abandoned —
// i.e. with unwatched aired episodes remaining, whether started or not,
// active or gone quiet. (Watch Next still queues those episodes; the Library
// lists the shows. "Abandoned" is the display label for the stored 'stopped'
// state — issue #222.) "Watch Later" (issue #257) is the shows half of the
// retired top-level Watchlist tab — saved-for-later shows, fed by the
// payload's separate watchlistShows bucket rather than derived state.
const STATE_SECTIONS: [string, string][] = [
  ["watching", "Watching"],
  ["up_to_date", "Up to date"],
  ["finished", "Finished"],
  ["stopped", "Abandoned"],
  ["watch_later", "Watch Later"],
];

// Derived watching (stale or not) and not-started shows with aired episodes
// fall under the Watching tab — tracked with something left to watch (issue
// #253). A followed show with nothing aired yet has nothing to be behind on,
// so it counts as up to date. The reference states map 1:1; every show lands
// in exactly one bucket.
function showBucket(s: LibShow): string {
  if (s.derivedState === "watching") return "watching";
  if (s.derivedState === "not_started") return s.aired > 0 ? "watching" : "up_to_date";
  return s.derivedState;
}

// The Library sort (issue #267): one control, shared by the Shows, Movies,
// and Anime tabs — each with its own persisted choice, so sorting Movies A–Z
// doesn't reorder Shows. The keys are viewer-local UI preferences, which is
// why the public library (issue #245) shares them too: the sort belongs to
// whoever is looking, not to whose library it is.
type LibrarySort = "last_watched" | "alphabetical";
const SHOW_SORT_KEY = "library-show-sort";
const MOVIE_SORT_KEY = "library-movie-sort";
const ANIME_SORT_KEY = "library-anime-sort";

// Last watched: most recent first; never-watched items sink to the bottom.
// Alphabetical is the tiebreak (and the whole order for "alphabetical").
// `watchedAt` maps the item to its timestamp — shows' last_watched_at is
// nullable, movies' watched_at never is (a Seen movie was, by definition).
function libraryComparator<T extends { title: string }>(
  sort: LibrarySort,
  watchedAt: (item: T) => string | null
) {
  return (a: T, b: T): number => {
    const aw = watchedAt(a);
    const bw = watchedAt(b);
    if (sort === "last_watched" && aw !== bw) {
      if (aw == null) return 1;
      if (bw == null) return -1;
      return aw > bw ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  };
}

const showComparator = (sort: LibrarySort) => libraryComparator<LibShow>(sort, (s) => s.last_watched_at);
const movieComparator = (sort: LibrarySort) => libraryComparator<LibMovie>(sort, (m) => m.watched_at);

function useLibrarySort(key: string): [LibrarySort, (value: LibrarySort) => void] {
  const [sort, setSort] = useState<LibrarySort>(() =>
    localStorage.getItem(key) === "alphabetical" ? "alphabetical" : "last_watched"
  );
  function change(value: LibrarySort) {
    setSort(value);
    localStorage.setItem(key, value);
  }
  return [sort, change];
}

function SortBar({ sort, onChange }: { sort: LibrarySort; onChange: (value: LibrarySort) => void }) {
  return (
    <div className="sort-bar">
      <label>
        Sort
        <select value={sort} onChange={(e) => onChange(e.target.value as LibrarySort)}>
          <option value="last_watched">Last watched</option>
          <option value="alphabetical">Alphabetical (A–Z)</option>
        </select>
      </label>
    </div>
  );
}

export interface LibShow {
  id: number;
  title: string;
  poster: string | null;
  derivedState: string;
  stale: boolean;
  watched: number;
  aired: number;
  total: number;
  last_watched_at: string | null;
  // Hidden from the owner's public surfaces (issue #260). Only the owner's
  // own payload ever carries it — the public library filters hidden shows
  // server-side — so the marker below can never render for a visitor.
  hidden?: boolean;
}
export interface LibMovie {
  id: number;
  title: string;
  poster: string | null;
  watched_at: string;
  play_count: number;
}
export interface WatchlistItem {
  id: number;
  title: string;
  poster: string | null;
}

// The progress meta line under a show poster, with a subtle "hidden" marker
// (issue #260) so the owner can spot — and go unhide — shows they've taken
// off their public profile. The show page's eye toggle is where that happens.
const showSub = (s: LibShow) => `${s.watched}/${s.aired}${s.hidden ? " · hidden" : ""}`;

// The shows library: a status tab bar (Watching / Up to date / Finished /
// Abandoned / Watch Later — only tabs that have shows appear), and the active
// tab's poster grid. Since the buckets partition the payload, the zero-tabs
// empty state only shows when there are no tracked or saved shows at all.
// Exported for the public library page (issue #245), which is read-only —
// this component already is: it only navigates and sorts. `empty` swaps the
// owner-directed zero-tabs message for visitor copy there; `watchlist` is
// owner-only (issue #257) — the public payload never carries the bucket, so
// no Watch Later tab can appear there.
export function ShowsLibrary({ shows, watchlist = [], empty }: { shows: LibShow[]; watchlist?: WatchlistItem[]; empty?: ReactElement }) {
  const [sort, setSort] = useLibrarySort(SHOW_SORT_KEY);
  const [tab, setTab] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const s of shows) {
    const b = showBucket(s);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  if (watchlist.length > 0) counts.set("watch_later", watchlist.length);
  const tabs = STATE_SECTIONS.filter(([key]) => counts.has(key));
  // Keep the chosen tab while it still holds shows; otherwise fall to the first.
  const activeKey = tab && counts.has(tab) ? tab : tabs[0]?.[0];
  const activeShows = shows.filter((s) => showBucket(s) === activeKey).sort(showComparator(sort));

  if (tabs.length === 0) {
    return (
      empty ?? (
        <Empty title="No shows yet" hint="Follow a show from search and it shows up here." />
      )
    );
  }

  return (
    <>
      <nav className="subtabs" aria-label="Library category">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={key === activeKey ? "active" : ""}
            aria-current={key === activeKey ? "true" : undefined}
            onClick={() => setTab(key)}
          >
            {label} <span className="count">{counts.get(key)}</span>
          </button>
        ))}
      </nav>
      {activeKey === "watch_later" ? (
        // Saved-for-later shows have no watch activity to sort or track —
        // plain poster cards, newest saves first (server order), no sort bar.
        <div className="poster-grid">
          {watchlist.map((s) => (
            <PosterCard key={s.id} to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} />
          ))}
        </div>
      ) : (
        <>
          <SortBar sort={sort} onChange={setSort} />
          <div className="poster-grid">
            {activeShows.map((s) =>
              // Finished shows (issue #223): every episode is watched, so the
              // watched/aired meta line and the always-full progress bar say
              // nothing — just the poster with an episode-count pill.
              activeKey === "finished" ? (
                <PosterCard
                  key={s.id}
                  to={mediaPath("show", s.id, s.title)}
                  posterPath={s.poster}
                  title={s.title}
                  pill={`${s.total} ${s.total === 1 ? "episode" : "episodes"}${s.hidden ? " · hidden" : ""}`}
                />
              ) : (
                <div key={s.id} className="lib-card">
                  <PosterCard to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} sub={showSub(s)} />
                  <Progress watched={s.watched} total={s.aired} />
                </div>
              )
            )}
          </div>
        </>
      )}
    </>
  );
}

// The movies tab's poster grid. `tz` shapes the watched-at sub line — the
// viewer's saved timezone here, the visitor's own on the public library page
// (issue #245), where AnimeLibrary below is reused as-is. Renders in the
// order given; sorting is the caller's business (AnimeLibrary shares one
// sort across its two sections, so the bar can't live in here).
export function MovieGrid({ movies, tz }: { movies: LibMovie[]; tz: string }) {
  return (
    <div className="poster-grid">
      {movies.map((m) => (
        <PosterCard
          key={m.id}
          to={mediaPath("movie", m.id, m.title)}
          posterPath={m.poster}
          title={m.title}
          sub={fmtDateTime(m.watched_at, tz)}
        />
      ))}
    </div>
  );
}

// MovieGrid under the Shows tab's sort bar (issue #267): watched movies,
// sortable just like shows. Both movie surfaces render this — the owner
// Library's Seen subtab and the public library's Movies tab — so the one
// persisted key follows the viewer across them.
export function SortedMovieGrid({ movies, tz }: { movies: LibMovie[]; tz: string }) {
  const [sort, setSort] = useLibrarySort(MOVIE_SORT_KEY);
  return (
    <>
      <SortBar sort={sort} onChange={setSort} />
      <MovieGrid movies={[...movies].sort(movieComparator(sort))} tz={tz} />
    </>
  );
}

// The movies library (issue #257): a subtab bar mirroring ShowsLibrary's.
// Movies have exactly two states (0001_init.sql CHECK: watched / watchlist),
// so Seen and Watch Later fully partition them — Seen is the payload's
// `movies` bucket (anime movies excluded there, they live on the Anime tab),
// Watch Later is `watchlistMovies` (unsplit — one planning list, exactly what
// the retired top-level Watchlist tab held). Owner-only: the public library
// page renders SortedMovieGrid directly, so no Watch Later leaks there.
function MoviesLibrary({ movies, watchlist = [], tz }: { movies: LibMovie[]; watchlist?: WatchlistItem[]; tz: string }) {
  const [tab, setTab] = useState<string | null>(null);

  const sections: [string, string, number][] = [
    ["seen", "Seen", movies.length],
    ["watch_later", "Watch Later", watchlist.length],
  ];
  const tabs = sections.filter(([, , count]) => count > 0);
  // Keep the chosen tab while it still holds movies; otherwise fall to the first.
  const activeKey = tab && tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];

  if (tabs.length === 0) {
    return <Empty title="No movies yet" hint="Mark a movie watched — or save it for later — and it lands here." />;
  }

  return (
    <>
      <nav className="subtabs" aria-label="Library category">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            className={key === activeKey ? "active" : ""}
            aria-current={key === activeKey ? "true" : undefined}
            onClick={() => setTab(key)}
          >
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </nav>
      {activeKey === "seen" ? (
        <SortedMovieGrid movies={movies} tz={tz} />
      ) : (
        // Watch Later: nothing watched yet, so nothing to sort and no
        // watched-at sub line — plain poster cards in the retired Watchlist
        // tab's order (server-side), no sort bar, same as Shows' Watch Later.
        <div className="poster-grid">
          {watchlist.map((m) => (
            <PosterCard key={m.id} to={mediaPath("movie", m.id, m.title)} posterPath={m.poster} title={m.title} />
          ))}
        </div>
      )}
    </>
  );
}

// The anime tab: shows (with progress) and movies as two headed sections.
// Callers guarantee at least one of the two is non-empty. One sort bar
// (issue #267) orders both sections — they're one collection split by medium,
// not two lists that would each earn a control.
export function AnimeLibrary({ shows, movies, tz }: { shows: LibShow[]; movies: LibMovie[]; tz: string }) {
  const [sort, setSort] = useLibrarySort(ANIME_SORT_KEY);
  return (
    <>
      <SortBar sort={sort} onChange={setSort} />
      {shows.length > 0 && (
        <section>
          <h2 className="section-title">Shows</h2>
          <div className="poster-grid">
            {[...shows].sort(showComparator(sort)).map((s) => (
              <div key={s.id} className="lib-card">
                <PosterCard to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} sub={showSub(s)} />
                <Progress watched={s.watched} total={s.aired} />
              </div>
            ))}
          </div>
        </section>
      )}
      {movies.length > 0 && (
        <section>
          <h2 className="section-title">Movies</h2>
          <MovieGrid movies={[...movies].sort(movieComparator(sort))} tz={tz} />
        </section>
      )}
    </>
  );
}

// The top-level tabs are media categories only (issue #257): the old
// Watchlist tab — a planning list posing as a peer of Shows/Movies/Anime, and
// the root of the "is Movies things I've watched?" confusion — is folded into
// Watch Later subtabs under Shows and Movies (/library/watchlist redirects
// here in app.tsx).
export function LibraryPage({ tab }: { tab: "shows" | "movies" | "anime" }) {
  const { user } = useAuth();
  const lib = useApi<{
    shows: LibShow[];
    movies: LibMovie[];
    animeShows: LibShow[];
    animeMovies: LibMovie[];
    // Optional: tolerates service-worker-cached pre-#257 payloads, which lack
    // the Watch Later buckets — they paint before revalidation (hooks.ts).
    watchlistShows?: WatchlistItem[];
    watchlistMovies?: WatchlistItem[];
  }>("/library");

  return (
    <div>
      <h1 className="page-title">Library</h1>
      <nav className="tabs" aria-label="Library sections">
        <NavLink to="/library" end>Shows</NavLink>
        <NavLink to="/library/movies">Movies</NavLink>
        <NavLink to="/library/anime">Anime</NavLink>
      </nav>

      {tab === "shows" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : (
          <ShowsLibrary shows={lib.data!.shows} watchlist={lib.data!.watchlistShows} />
        ))}

      {tab === "movies" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : (
          <MoviesLibrary movies={lib.data!.movies} watchlist={lib.data!.watchlistMovies} tz={user!.tz} />
        ))}

      {tab === "anime" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : !lib.data?.animeShows.length && !lib.data?.animeMovies.length ? (
          <Empty title="No anime yet" hint="Follow an anime show or mark an anime movie watched and it lands here." />
        ) : (
          <AnimeLibrary shows={lib.data!.animeShows} movies={lib.data!.animeMovies} tz={user!.tz} />
        ))}
    </div>
  );
}
