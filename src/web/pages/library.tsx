import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { PosterCard, Progress, Spinner, Empty, ErrorNote } from "../components/ui";
import { mediaPath } from "../paths";

const STATE_SECTIONS: [string, string][] = [
  ["watching", "Watching"],
  ["not_started", "Not started yet"],
  ["up_to_date", "Up to date"],
  ["finished", "Finished"],
  ["stopped", "Stopped"],
];

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
interface FavoriteItem {
  type: "show" | "movie";
  id: number;
  list_id: number;
  title: string;
  poster: string | null;
}

export function LibraryPage({ tab }: { tab: "shows" | "movies" | "watchlist" }) {
  const { user } = useAuth();
  const [sort, setSort] = useState<ShowSort>(() =>
    localStorage.getItem(SORT_KEY) === "alphabetical" ? "alphabetical" : "last_watched"
  );
  const lib = useApi<{ shows: LibShow[]; movies: LibMovie[]; favorites: FavoriteItem[] }>(
    tab !== "watchlist" ? "/library" : null
  );
  const wl = useApi<{ shows: WatchlistItem[]; movies: WatchlistItem[] }>(tab === "watchlist" ? "/watchlist" : null);

  function changeSort(value: ShowSort) {
    setSort(value);
    localStorage.setItem(SORT_KEY, value);
  }

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
        ) : !lib.data?.shows.length && !lib.data?.favorites.length ? (
          <Empty title="No shows yet" hint="Follow a show from search and it shows up here." />
        ) : (
          <>
          {lib.data!.favorites.length > 0 && (
            <section>
              <h2 className="section-title">
                Favorites
                <Link to={`/lists/${lib.data!.favorites[0].list_id}`} className="section-link">View list</Link>
              </h2>
              <div className="poster-grid">
                {lib.data!.favorites.map((f) => (
                  <PosterCard key={`${f.type}-${f.id}`} to={`/${f.type}/${f.id}`} posterPath={f.poster} title={f.title} />
                ))}
              </div>
            </section>
          )}
          {lib.data!.shows.length > 0 && (
            <div className="sort-bar">
              <label>
                Sort
                <select value={sort} onChange={(e) => changeSort(e.target.value as ShowSort)}>
                  <option value="last_watched">Last watched</option>
                  <option value="alphabetical">Alphabetical (A–Z)</option>
                </select>
              </label>
            </div>
          )}
          {STATE_SECTIONS.map(([key, label]) => {
            const shows = lib.data!.shows.filter((s) => s.derivedState === key).sort(showComparator(sort));
            if (!shows.length) return null;
            return (
              <section key={key}>
                <h2 className="section-title">{label}</h2>
                <div className="poster-grid">
                  {shows.map((s) => (
                    <div key={s.id} className="lib-card">
                      <PosterCard to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} sub={`${s.watched}/${s.aired}`} />
                      <Progress watched={s.watched} total={s.aired} />
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          </>
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
