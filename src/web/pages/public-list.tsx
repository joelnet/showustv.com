// Public, read-only list view — reachable without an account at
// /u/:username/lists/:id when the owner has made the list public.
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { Spinner, PosterCard, Wordmark, SmpteBars } from "../components/ui";
import { mediaPath } from "../paths";

interface PublicList {
  list: { id: number; name: string; username: string };
  items: { type: "show" | "movie"; id: number; title: string; poster: string | null }[];
}

export function PublicListPage() {
  const { username, id } = useParams();
  const { data, loading, error } = useApi<PublicList>(`/public/lists/${encodeURIComponent(username!)}/${id}`);

  return (
    <div className="public-page">
      <header className="header">
        <Link to="/" className="header-brand" aria-label="Show Us TV — home">
          <Wordmark />
        </Link>
      </header>
      <main className="main">
        {loading ? (
          <Spinner />
        ) : error || !data ? (
          <div className="empty">
            <SmpteBars />
            <h3>Nothing to see here</h3>
            <p>This list is private or doesn&rsquo;t exist.</p>
          </div>
        ) : (
          <>
            <h1 className="page-title">{data.list.name}</h1>
            <p className="public-byline">
              A list by <strong>{data.list.username}</strong> · {data.items.length}{" "}
              {data.items.length === 1 ? "title" : "titles"}
            </p>
            <div className="poster-grid">
              {data.items.map((it) => (
                <PosterCard
                  key={`${it.type}-${it.id}`}
                  to={mediaPath(it.type, it.id, it.title)}
                  posterPath={it.poster}
                  title={it.title}
                  sub={it.type === "show" ? "TV" : "Movie"}
                />
              ))}
            </div>
          </>
        )}
      </main>
      <footer className="footer">
        <span>
          This product uses the <a href="https://www.themoviedb.org">TMDB</a> API but is not endorsed or
          certified by TMDB.
        </span>
      </footer>
    </div>
  );
}
