import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { PosterCard, Progress, Spinner, Empty, ErrorNote } from "../components/ui";
import { mediaPath } from "../paths";

// Tab order: the four the issue names come first; Not started / Stopped follow
// and only surface when non-empty. "stale" is the split-out slice of watching.
const STATE_SECTIONS: [string, string][] = [
  ["watching", "Watching"],
  ["stale", "Haven’t watched for a while"],
  ["up_to_date", "Up to date"],
  ["finished", "Finished"],
  ["not_started", "Not started yet"],
  ["stopped", "Stopped"],
];

// A watching show with no recent activity (the server's `stale` flag) splits
// out of "Watching" into its own bucket; every other state maps 1:1.
function showBucket(s: LibShow): string {
  if (s.derivedState === "watching") return s.stale ? "stale" : "watching";
  return s.derivedState;
}

type ShowSort = "last_watched" | "alphabetical";
const SORT_KEY = "library-show-sort";

// Last watched: most recent first; never-watched shows sink to the bottom.
// Alphabetical is the tiebreak (and the whole order for "alphabetical").
function showComparator(sort: ShowSort) {
  return (a: LibShow, b: LibShow): number => {
    if (sort === "last_watched" && a.last_watched_at !== b.last_watched_at) {
      if (a.last_watched_at == null) return 1;
      if (b.last_watched_at == null) return -1;
      return a.last_watched_at > b.last_watched_at ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  };
}

interface LibShow {
  id: number;
  title: string;
  poster: string | null;
  derivedState: string;
  stale: boolean;
  watched: number;
  aired: number;
  total: number;
  last_watched_at: string | null;
}
interface LibMovie {
  id: number;
  title: string;
  poster: string | null;
  watched_at: string;
  play_count: number;
}
interface WatchlistItem {
  id: number;
  title: string;
  poster: string | null;
}

// The shows library: a status tab bar (Watching / Haven't watched for a while /
// Up to date / Finished / Not started / Stopped — only tabs that have shows
// appear), and the active tab's poster grid.
function ShowsLibrary({ shows }: { shows: LibShow[] }) {
  const [sort, setSort] = useState<ShowSort>(() =>
    localStorage.getItem(SORT_KEY) === "alphabetical" ? "alphabetical" : "last_watched"
  );
  const [tab, setTab] = useState<string | null>(null);

  function changeSort(value: ShowSort) {
    setSort(value);
    localStorage.setItem(SORT_KEY, value);
  }

  const counts = new Map<string, number>();
  for (const s of shows) {
    const b = showBucket(s);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const tabs = STATE_SECTIONS.filter(([key]) => counts.has(key));
  // Keep the chosen tab while it still holds shows; otherwise fall to the first.
  const activeKey = tab && counts.has(tab) ? tab : tabs[0]?.[0];
  const activeShows = shows.filter((s) => showBucket(s) === activeKey).sort(showComparator(sort));

  return (
    <>
      {tabs.length > 0 && (
        <>
          <nav className="subtabs" aria-label="Show status">
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
          <div className="sort-bar">
            <label>
              Sort
              <select value={sort} onChange={(e) => changeSort(e.target.value as ShowSort)}>
                <option value="last_watched">Last watched</option>
                <option value="alphabetical">Alphabetical (A–Z)</option>
              </select>
            </label>
          </div>
          <div className="poster-grid">
            {activeShows.map((s) => (
              <div key={s.id} className="lib-card">
                <PosterCard to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} sub={`${s.watched}/${s.aired}`} />
                <Progress watched={s.watched} total={s.aired} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function LibraryPage({ tab }: { tab: "shows" | "movies" | "watchlist" }) {
  const { user } = useAuth();
  const lib = useApi<{ shows: LibShow[]; movies: LibMovie[] }>(
    tab !== "watchlist" ? "/library" : null
  );
  const wl = useApi<{ shows: WatchlistItem[]; movies: WatchlistItem[] }>(tab === "watchlist" ? "/watchlist" : null);

  return (
    <div>
      <h1 className="page-title">Library</h1>
      <nav className="tabs" aria-label="Library sections">
        <NavLink to="/library" end>Shows</NavLink>
        <NavLink to="/library/movies">Movies</NavLink>
        <NavLink to="/library/watchlist">Watchlist</NavLink>
      </nav>

      {tab === "shows" &&
        (lib.loading ? (
          <Spinner />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : !lib.data?.shows.length ? (
          <Empty title="No shows yet" hint="Follow a show from search and it shows up here." />
        ) : (
          <ShowsLibrary shows={lib.data!.shows} />
        ))}

      {tab === "movies" &&
        (lib.loading ? (
          <Spinner />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : !lib.data?.movies.length ? (
          <Empty title="No movies watched yet" hint="Mark a movie watched and it lands here." />
        ) : (
          <div className="poster-grid">
            {lib.data.movies.map((m) => (
              <PosterCard
                key={m.id}
                to={mediaPath("movie", m.id, m.title)}
                posterPath={m.poster}
                title={m.title}
                sub={fmtDateTime(m.watched_at, user!.tz)}
              />
            ))}
          </div>
        ))}

      {tab === "watchlist" &&
        (wl.loading ? (
          <Spinner />
        ) : wl.error ? (
          <ErrorNote message={wl.error} />
        ) : !wl.data?.shows.length && !wl.data?.movies.length ? (
          <Empty title="Watchlist is empty" hint="Save shows and movies for later with “Watch later”." />
        ) : (
          <>
            {wl.data!.shows.length > 0 && (
              <section>
                <h2 className="section-title">Shows</h2>
                <div className="poster-grid">
                  {wl.data!.shows.map((s) => (
                    <PosterCard key={s.id} to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} />
                  ))}
                </div>
              </section>
            )}
            {wl.data!.movies.length > 0 && (
              <section>
                <h2 className="section-title">Movies</h2>
                <div className="poster-grid">
                  {wl.data!.movies.map((m) => (
                    <PosterCard key={m.id} to={mediaPath("movie", m.id, m.title)} posterPath={m.poster} title={m.title} />
                  ))}
                </div>
              </section>
            )}
          </>
        ))}
    </div>
  );
}
