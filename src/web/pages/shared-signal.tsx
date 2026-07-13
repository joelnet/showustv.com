import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { del, put } from "../api";
import { useAuth } from "../app";
import {
  TasteGraph,
  type TasteGraphMovie,
  type TasteGraphPayload,
  type TasteSelection,
} from "../components/taste-graph";
import { IconHeart, IconHeartOutline, IconList, IconShare, IconUsers } from "../components/icons";
import { RowListSkeleton } from "../components/skeleton";
import { Empty, ErrorNote } from "../components/ui";
import { useApi, useDocumentTitle } from "../hooks";
import { poster } from "../img";
import { mediaPath } from "../paths";

type FavoriteFilter = "all" | "mutual" | "mine" | "theirs";
type ViewMode = "graph" | "list";

const FILTERS: { value: FavoriteFilter; label: string; title: string }[] = [
  { value: "all", label: "All shared", title: "Movies you and at least one mutual watched" },
  { value: "mutual", label: "Mutual favorites", title: "Movies you and at least one mutual both favorited" },
  { value: "mine", label: "Your favorites", title: "Your favorite movies that a mutual watched" },
  { value: "theirs", label: "Loved by mutuals", title: "Shared movies at least one mutual favorited" },
];

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function FavoriteMarks({ movie }: { movie: TasteGraphMovie }) {
  return (
    <span className="taste-favorite-marks">
      {movie.myFavorite && (
        <span className="taste-favorite-mark is-mine" title="Your favorite">
          <IconHeart size={12} /> You
        </span>
      )}
      {movie.mutualFavoriteCount > 0 && (
        <span className="taste-favorite-mark" title={`${movie.mutualFavoriteCount} mutual favorites`}>
          <IconHeart size={12} /> {movie.mutualFavoriteCount}
        </span>
      )}
    </span>
  );
}

export function SharedSignalPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<TasteGraphPayload>("/social/taste-graph");
  const [favoriteFilter, setFavoriteFilter] = useState<FavoriteFilter>("all");
  const [mutualFilter, setMutualFilter] = useState("all");
  const webglSupported = useMemo(supportsWebGL, []);
  const [view, setView] = useState<ViewMode>(() => (webglSupported ? "graph" : "list"));
  const [selected, setSelected] = useState<TasteSelection>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [favoriteBusy, setFavoriteBusy] = useState<number | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  useDocumentTitle("Shared Signal");

  const movies = useMemo(
    () =>
      (data?.movies ?? []).map((movie) => {
        const override = favoriteOverrides.get(movie.id);
        const myFavorite = override ?? movie.myFavorite;
        return {
          ...movie,
          myFavorite,
          mutualFavorite: myFavorite && movie.mutualFavoriteCount > 0,
        };
      }),
    [data?.movies, favoriteOverrides]
  );

  const visibleMovies = useMemo(() => {
    if (!data) return [];
    const mutualMovieIds =
      mutualFilter === "all"
        ? null
        : new Set(data.links.filter((link) => link.person === mutualFilter).map((link) => link.movie));
    const selectedMutualFavorites =
      mutualFilter === "all"
        ? null
        : new Set(
            data.links
              .filter((link) => link.person === mutualFilter && link.favorite)
              .map((link) => link.movie)
          );
    return movies.filter((movie) => {
      if (mutualMovieIds && !mutualMovieIds.has(movie.id)) return false;
      if (favoriteFilter === "mutual")
        return movie.myFavorite && (selectedMutualFavorites ? selectedMutualFavorites.has(movie.id) : movie.mutualFavorite);
      if (favoriteFilter === "mine") return movie.myFavorite;
      if (favoriteFilter === "theirs")
        return selectedMutualFavorites ? selectedMutualFavorites.has(movie.id) : movie.mutualFavoriteCount > 0;
      return true;
    });
  }, [data, favoriteFilter, movies, mutualFilter]);

  const visibleLinks = useMemo(() => {
    if (!data) return [];
    const movieIds = new Set(visibleMovies.map((movie) => movie.id));
    return data.links.filter(
      (link) => movieIds.has(link.movie) && (mutualFilter === "all" || link.person === mutualFilter)
    );
  }, [data, mutualFilter, visibleMovies]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "movie" && !visibleMovies.some((movie) => movie.id === selected.id)) setSelected(null);
    if (selected.kind === "person" && !visibleLinks.some((link) => link.person === selected.username)) setSelected(null);
  }, [selected, visibleLinks, visibleMovies]);

  useEffect(() => {
    setFavoriteError(null);
  }, [selected?.kind, selected?.kind === "movie" ? selected.id : selected?.kind === "person" ? selected.username : null]);

  const selectedMovie =
    selected?.kind === "movie" ? movies.find((movie) => movie.id === selected.id) ?? null : null;
  const selectedPerson = selected?.kind === "person" ? selected.username : null;
  const visibleMutualCount = new Set(visibleLinks.map((link) => link.person)).size;

  const toggleFavorite = async (movie: TasteGraphMovie) => {
    const next = !movie.myFavorite;
    setFavoriteBusy(movie.id);
    setFavoriteError(null);
    setFavoriteOverrides((current) => new Map(current).set(movie.id, next));
    try {
      if (next) await put(`/movies/${movie.id}/favorite`);
      else await del(`/movies/${movie.id}/favorite`);
      reload();
    } catch (e) {
      setFavoriteOverrides((current) => new Map(current).set(movie.id, movie.myFavorite));
      setFavoriteError(e instanceof Error ? e.message : "Couldn't update that favorite");
    } finally {
      setFavoriteBusy(null);
    }
  };

  if (loading)
    return (
      <div>
        <Link className="crumb" to="/following">← Following</Link>
        <h1 className="page-title">Shared Signal</h1>
        <RowListSkeleton count={6} />
      </div>
    );
  if (error) return <ErrorNote message={error} />;
  if (!data || !user) return null;

  if (!data.summary.mutualCount)
    return (
      <div>
        <Link className="crumb" to="/following">← Following</Link>
        <h1 className="page-title">Shared Signal</h1>
        <Empty title="No mutuals yet" hint="Follow each other first, then your shared movies land here." />
        <Link to="/following" className="btn btn-ghost taste-empty-action">
          <IconUsers size={15} /> Find people
        </Link>
      </div>
    );

  return (
    <div className="taste-page">
      <Link className="crumb" to="/following">← Following</Link>
      <div className="taste-page-head">
        <div>
          <h1 className="page-title">Shared Signal</h1>
          <p>Movies you and your mutuals have both watched.</p>
        </div>
        <p className="mono taste-summary" aria-live="polite">
          {visibleMovies.length} {visibleMovies.length === 1 ? "movie" : "movies"} · {visibleMutualCount}{" "}
          {visibleMutualCount === 1 ? "mutual" : "mutuals"}
        </p>
      </div>

      {data.summary.truncated && (
        <p className="taste-limit-note">
          Showing your {data.summary.mutualsShown} most recent mutuals out of {data.summary.mutualCount}.
        </p>
      )}

      {!data.movies.length ? (
        <Empty title="No shared movies yet" hint="Your watch histories haven't crossed yet." />
      ) : (
        <>
          <div className="taste-toolbar" aria-label="Shared movie filters">
            <div className="taste-filter-tabs" role="group" aria-label="Favorite filter">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={favoriteFilter === filter.value}
                  className={favoriteFilter === filter.value ? "is-on" : ""}
                  title={filter.title}
                  onClick={() => setFavoriteFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <label className="taste-mutual-select">
              <span>Compare</span>
              <select value={mutualFilter} onChange={(event) => setMutualFilter(event.target.value)}>
                <option value="all">All mutuals</option>
                {data.mutuals.map((mutual) => (
                  <option key={mutual.username} value={mutual.username}>
                    {mutual.username}
                  </option>
                ))}
              </select>
            </label>

            <div className="taste-view-switch" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={view === "graph"}
                disabled={!webglSupported}
                title={webglSupported ? "Show graph" : "Graph view needs WebGL"}
                onClick={() => setView("graph")}
              >
                <IconShare size={14} /> Graph
              </button>
              <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
                <IconList size={14} /> List
              </button>
            </div>
          </div>

          {!visibleMovies.length ? (
            <Empty title="Nothing on this channel" hint="Try another favorite filter or compare everyone again." />
          ) : (
            <div className={`taste-workspace taste-workspace--${view}`}>
              <main className="taste-visual">
                {view === "graph" ? (
                  <TasteGraph
                    movies={visibleMovies}
                    links={visibleLinks}
                    selfUsername={user.username}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ) : (
                  <ul className="taste-list" aria-label="Shared movies">
                    {visibleMovies.map((movie) => {
                      const image = poster(movie.poster, "w154");
                      return (
                        <li key={movie.id}>
                          <button
                            type="button"
                            className={selectedMovie?.id === movie.id ? "is-selected" : ""}
                            onClick={() => setSelected({ kind: "movie", id: movie.id })}
                          >
                            {image ? (
                              <img src={image} alt="" loading="lazy" />
                            ) : (
                              <span className="taste-list-poster-fallback"><IconShare size={18} /></span>
                            )}
                            <span className="taste-list-copy">
                              <strong>{movie.title}</strong>
                              <span className="mono">
                                {movie.releaseYear ?? "Year unknown"} · shared with {movie.mutualViewerCount}
                              </span>
                              <FavoriteMarks movie={movie} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </main>

              <aside className="taste-detail" aria-live="polite">
                {selectedMovie ? (
                  <MovieDetail
                    movie={selectedMovie}
                    links={visibleLinks}
                    busy={favoriteBusy === selectedMovie.id}
                    error={favoriteError}
                    onToggleFavorite={() => void toggleFavorite(selectedMovie)}
                    onSelectPerson={(username) => setSelected({ kind: "person", username })}
                  />
                ) : selectedPerson ? (
                  <PersonDetail
                    username={selectedPerson}
                    movies={visibleMovies.filter((movie) =>
                      visibleLinks.some((link) => link.person === selectedPerson && link.movie === movie.id)
                    )}
                    favoriteMovieIds={new Set(
                      visibleLinks
                        .filter((link) => link.person === selectedPerson && link.favorite)
                        .map((link) => link.movie)
                    )}
                    onCompare={() => {
                      setMutualFilter(selectedPerson);
                      setSelected(null);
                    }}
                    onSelectMovie={(id) => setSelected({ kind: "movie", id })}
                  />
                ) : (
                  <GraphKey />
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MovieDetail({
  movie,
  links,
  busy,
  error,
  onToggleFavorite,
  onSelectPerson,
}: {
  movie: TasteGraphMovie;
  links: TasteGraphPayload["links"];
  busy: boolean;
  error: string | null;
  onToggleFavorite: () => void;
  onSelectPerson: (username: string) => void;
}) {
  const image = poster(movie.poster, "w342");
  const viewers = links
    .filter((link) => link.movie === movie.id)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.person.localeCompare(b.person));
  const isMutualFavorite = movie.myFavorite && viewers.some((viewer) => viewer.favorite);

  return (
    <>
      {image && <img className="taste-detail-poster" src={image} alt={`Poster for ${movie.title}`} />}
      <p className="mono taste-detail-kicker">MOVIE · {movie.releaseYear ?? "YEAR UNKNOWN"}</p>
      <h2>{movie.title}</h2>
      {isMutualFavorite && <p className="taste-mutual-favorite"><IconHeart size={13} /> Mutual favorite</p>}
      <button
        type="button"
        className={`btn btn-ghost taste-favorite-action${movie.myFavorite ? " is-on" : ""}`}
        aria-pressed={movie.myFavorite}
        disabled={busy}
        onClick={onToggleFavorite}
      >
        {movie.myFavorite ? <IconHeart size={15} /> : <IconHeartOutline size={15} />}
        {movie.myFavorite ? "Favorited" : "Add to favorites"}
      </button>
      {error && <ErrorNote message={error} />}

      <h3>Shared with</h3>
      <ul className="taste-viewers">
        {viewers.map((viewer) => (
          <li key={viewer.person}>
            <button type="button" onClick={() => onSelectPerson(viewer.person)}>
              <span>{viewer.person}</span>
              {viewer.favorite && <span className="taste-viewer-favorite"><IconHeart size={12} /> favorite</span>}
            </button>
          </li>
        ))}
      </ul>
      <Link className="btn btn-ghost taste-detail-link" to={mediaPath("movie", movie.id, movie.title)}>
        View movie
      </Link>
    </>
  );
}

function PersonDetail({
  username,
  movies,
  favoriteMovieIds,
  onCompare,
  onSelectMovie,
}: {
  username: string;
  movies: TasteGraphMovie[];
  favoriteMovieIds: ReadonlySet<number>;
  onCompare: () => void;
  onSelectMovie: (id: number) => void;
}) {
  return (
    <>
      <p className="mono taste-detail-kicker">MUTUAL</p>
      <h2>{username}</h2>
      <p>
        You share {movies.length} {movies.length === 1 ? "movie" : "movies"} in this signal.
      </p>
      <div className="taste-detail-actions">
        <button type="button" className="btn" onClick={onCompare}>Compare only</button>
        <Link className="btn btn-ghost" to={`/u/${username}`}>Profile</Link>
      </div>
      <h3>Shared movies</h3>
      <ul className="taste-person-movies">
        {movies.slice(0, 12).map((movie) => (
          <li key={movie.id}>
            <button type="button" onClick={() => onSelectMovie(movie.id)}>
              <span>{movie.title}</span>
              {movie.myFavorite && favoriteMovieIds.has(movie.id) && <IconHeart size={12} />}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function GraphKey() {
  return (
    <>
      <p className="mono taste-detail-kicker">PATCH BAY</p>
      <h2>Pick a signal</h2>
      <p>Select a movie or mutual to isolate their connections.</p>
      <ul className="taste-key">
        <li><span className="taste-key-dot is-you" /> You</li>
        <li><span className="taste-key-dot is-mutual" /> Mutual</li>
        <li><span className="taste-key-poster" /> Movie</li>
        <li><IconHeart size={12} /> Favorite connection</li>
      </ul>
      <p className="taste-detail-hint">Drag to pan. Scroll or pinch to zoom. List view carries the same movies for keyboard navigation.</p>
    </>
  );
}
