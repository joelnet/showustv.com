// Public, read-only list view — reachable without an account at
// /u/:username/lists/:id when the owner has made the list public.
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { Spinner, Wordmark, SmpteBars, SiteFooter } from "../components/ui";
import { Comments } from "../components/comments";
import { poster } from "../img";
import { mediaPath, idFromParam, publicListPath } from "../paths";

interface PublicList {
  list: {
    id: number;
    name: string;
    username: string;
    profilePublic: boolean;
    preamble: string | null;
    commentsEnabled: boolean;
  };
  items: { type: "show" | "movie"; id: number; title: string; poster: string | null; overview: string | null }[];
}

export function PublicListPage() {
  const { username } = useParams();
  const id = idFromParam(useParams().id); // tolerate the "2-favorites" slug suffix
  const location = useLocation();
  const navigate = useNavigate();
  const { data, loading, error } = useApi<PublicList>(`/public/lists/${encodeURIComponent(username!)}/${id}`);
  const { user } = useAuth();

  // Canonicalize the address bar to the slugged URL once the name is known,
  // matching the show/movie detail pages.
  useEffect(() => {
    if (!data) return;
    const canonical = publicListPath(data.list.username, data.list.id, data.list.name);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location.pathname, location.search, navigate]);

  return (
    <div className="public-page">
      <header className="header">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
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
              A list by{" "}
              {data.list.profilePublic ? (
                <Link to={`/u/${data.list.username}`}>{data.list.username}</Link>
              ) : (
                <strong>{data.list.username}</strong>
              )}{" "}
              · {data.items.length} {data.items.length === 1 ? "title" : "titles"}
            </p>
            {data.list.preamble && <p className="list-preamble">{data.list.preamble}</p>}
            <ul className="pub-list">
              {data.items.map((it) => {
                const src = poster(it.poster);
                const to = mediaPath(it.type, it.id, it.title);
                return (
                  <li key={`${it.type}-${it.id}`} className="pub-list-item">
                    <Link to={to} className="pub-list-poster" aria-label={`View ${it.title}`}>
                      {src ? (
                        <img src={src} alt="" loading="lazy" />
                      ) : (
                        <div className="poster-fallback">{it.title}</div>
                      )}
                    </Link>
                    <div className="pub-list-body">
                      <Link to={to} className="pub-list-title">
                        {it.title}
                      </Link>
                      <span className="pub-list-type">{it.type === "show" ? "TV" : "Movie"}</span>
                      {it.overview && <p className="pub-list-overview">{it.overview}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
            {data.list.commentsEnabled &&
              (user ? (
                <section className="list-comments">
                  <h2 className="section-title">Comments</h2>
                  <Comments targetType="list" targetId={data.list.id} />
                </section>
              ) : (
                <p className="settings-hint list-comments-note">
                  <Link to="/login">Sign in</Link> to read and post comments on this list.
                </p>
              ))}
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
