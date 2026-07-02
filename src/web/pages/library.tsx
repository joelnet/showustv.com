import { Link, NavLink } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { PosterCard, Progress, Spinner, Empty, ErrorNote } from "../components/ui";

const STATE_SECTIONS: [string, string][] = [
  ["watching", "Watching"],
  ["not_started", "Not started yet"],
  ["up_to_date", "Up to date"],
  ["finished", "Finished"],
  ["stopped", "Stopped"],
];

interface LibShow {
  id: number;
  title: string;
  poster: string | null;
  derivedState: string;
  watched: number;
  aired: number;
  total: number;
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
  const lib = useApi<{ shows: LibShow[]; movies: LibMovie[]; favorites: FavoriteItem[] }>(
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
          {STATE_SECTIONS.map(([key, label]) => {
            const shows = lib.data!.shows.filter((s) => s.derivedState === key);
            if (!shows.length) return null;
            return (
              <section key={key}>
                <h2 className="section-title">{label}</h2>
                <div className="poster-grid">
                  {shows.map((s) => (
                    <div key={s.id} className="lib-card">
                      <PosterCard to={`/show/${s.id}`} posterPath={s.poster} title={s.title} sub={`${s.watched}/${s.aired}`} />
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
                to={`/movie/${m.id}`}
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
                    <PosterCard key={s.id} to={`/show/${s.id}`} posterPath={s.poster} title={s.title} />
                  ))}
                </div>
              </section>
            )}
            {wl.data!.movies.length > 0 && (
              <section>
                <h2 className="section-title">Movies</h2>
                <div className="poster-grid">
                  {wl.data!.movies.map((m) => (
                    <PosterCard key={m.id} to={`/movie/${m.id}`} posterPath={m.poster} title={m.title} />
                  ))}
                </div>
              </section>
            )}
          </>
        ))}
    </div>
  );
}
