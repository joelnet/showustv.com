// Read-only list view — a non-owner (or signed-out visitor from a shared
// link) sees this at /u/:username/lists/:id-slug when the owner has made the
// list public. Renders inside PublicShell (signed-out) or the app Shell
// (signed-in), so it returns just the content, no chrome of its own — the
// owner gets the editable ListDetailPage at the same URL instead (issue #319).
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { SmpteBars } from "../components/ui";
import { ShareButton } from "../components/share";
import { PubListSkeleton } from "../components/skeleton";
import { Comments } from "../components/comments";
import { poster } from "../img";
import { mediaPath, idFromParam, publicListPath } from "../paths";

interface PublicList {
  list: {
    id: number;
    name: string;
    username: string;
    preamble: string | null;
    commentsEnabled: boolean;
  };
  items: {
    type: "show" | "movie";
    id: number;
    title: string;
    poster: string | null;
    overview: string | null;
    // The list owner's own top-level comment on this title (issue #322), if any:
    // shown read-only here and linking to the title page where it lives.
    ownerComment: { body: string; createdAt: string; editedAt: string | null } | null;
  }[];
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
    <>
      {loading ? (
        <PubListSkeleton />
      ) : error || !data ? (
        <div className="empty">
          <SmpteBars />
          <h3>Nothing to see here</h3>
          <p>This list is private or doesn&rsquo;t exist.</p>
        </div>
      ) : (
        <>
          {/* Share sits right of the name, icon-only (issue #319), mirroring
              the public profile header. This page only renders for public
              lists (the server 404s private ones), so it's always safe. */}
          <div className="list-title-wrap">
            <h1 className="page-title">{data.list.name}</h1>
            <ShareButton
              variant="icon"
              title={data.list.name}
              text={`A list by ${data.list.username} on Show Us TV.`}
              path={publicListPath(data.list.username, data.list.id, data.list.name)}
            />
          </div>
          <p className="public-byline">
            {/* Always linked: a private profile renders its teaser now
                (issue #158) instead of 404ing, so the link is safe. */}
            A list by <Link to={`/u/${data.list.username}`}>{data.list.username}</Link> · {data.items.length}{" "}
            {data.items.length === 1 ? "title" : "titles"}
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
                    {/* The owner's own top-level comment on this title (issue
                        #322), read-only: no composer, vote, or reply — the whole
                        block just links to the title page where the comment
                        lives and where a reader can actually join the thread. */}
                    {it.ownerComment && (
                      <Link
                        to={to}
                        className="pub-list-comment"
                        title={`Read ${data.list.username}’s comment on ${it.title}`}
                      >
                        <span className="pub-list-comment-body">{it.ownerComment.body}</span>
                        <span className="pub-list-comment-src mono">— {data.list.username} · view on title ↗</span>
                      </Link>
                    )}
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
    </>
  );
}
