import { useSearchParams } from "react-router-dom";
import { useApi } from "../hooks";
import { useOffline } from "../offline";
import { PosterCard, Empty, ErrorNote } from "../components/ui";
import { PosterGridSkeleton, TrendingSkeleton } from "../components/skeleton";
import { IconSearch } from "../components/icons";
import { mediaPath } from "../paths";

interface Result {
  type: "show" | "movie";
  id: number;
  title: string;
  year: string | null;
  poster: string | null;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { online } = useOffline();
  const q = params.get("q") ?? "";
  const search = useApi<{ results: Result[] }>(q ? `/search?q=${encodeURIComponent(q)}` : null);
  const trending = useApi<{ shows: Result[]; movies: Result[] }>(!q ? "/trending" : null);

  // Search genuinely needs the network — a friendly note beats a broken error.
  const offlineNote = (
    <Empty title="You're offline" hint="Search needs a connection. Your library and lists still work offline." />
  );

  return (
    <div>
      <h1 className="page-title">Search</h1>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = (new FormData(e.currentTarget).get("q") as string).trim();
          setParams(next ? { q: next } : {});
        }}
      >
        <IconSearch size={18} />
        <input
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search shows & movies"
          aria-label="Search shows and movies"
          autoFocus
        />
        <button className="btn" type="submit">Search</button>
      </form>

      {q ? (
        search.loading ? (
          <PosterGridSkeleton />
        ) : search.error ? (
          online ? <ErrorNote message={search.error} /> : offlineNote
        ) : search.data?.results.length ? (
          <div className="poster-grid">
            {search.data.results.map((r) => (
              <PosterCard
                key={`${r.type}-${r.id}`}
                to={mediaPath(r.type, r.id, r.title)}
                posterPath={r.poster}
                title={r.title}
                sub={[r.type === "show" ? "TV" : "Movie", r.year].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
        ) : (
          <Empty title={`Nothing found for “${q}”`} hint="Check the spelling or try another title." />
        )
      ) : trending.loading ? (
        <TrendingSkeleton />
      ) : trending.data ? (
        <>
          <h2 className="section-title">Trending shows this week</h2>
          <div className="poster-grid">
            {trending.data.shows.map((r) => (
              <PosterCard key={r.id} to={mediaPath("show", r.id, r.title)} posterPath={r.poster} title={r.title} sub={r.year} />
            ))}
          </div>
          <h2 className="section-title">Trending movies</h2>
          <div className="poster-grid">
            {trending.data.movies.map((r) => (
              <PosterCard key={r.id} to={mediaPath("movie", r.id, r.title)} posterPath={r.poster} title={r.title} sub={r.year} />
            ))}
          </div>
        </>
      ) : trending.error ? (
        online ? <ErrorNote message={trending.error} /> : offlineNote
      ) : null}
    </div>
  );
}
