// Public, read-only profile — reachable without an account at /u/:username
// when the owner has made their profile public. Shows watch stats plus the
// lists they pinned (public lists only).
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { poster } from "../img";
import { Spinner, Wordmark, SmpteBars } from "../components/ui";
import { IconList } from "../components/icons";
import { StatsGrid, type WatchStats } from "./profile";

interface PublicProfile {
  username: string;
  stats: WatchStats;
  lists: { id: number; name: string; count: number; posters: string[] }[];
}

export function PublicProfilePage() {
  const { username } = useParams();
  const { data, loading, error } = useApi<PublicProfile>(`/public/profile/${encodeURIComponent(username!)}`);

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
            <p>This profile is private or doesn&rsquo;t exist.</p>
          </div>
        ) : (
          <>
            <h1 className="page-title">{data.username}</h1>
            <p className="public-byline">Watching TV on Show Us TV</p>
            <StatsGrid stats={data.stats} />
            {data.lists.length > 0 && (
              <>
                <h2 className="section-title">Lists</h2>
                <div className="lists-grid">
                  {data.lists.map((l) => (
                    <Link key={l.id} to={`/u/${username}/lists/${l.id}`} className="list-card">
                      <div className="list-collage">
                        {l.posters.length ? (
                          l.posters.map((p, i) => <img key={i} src={poster(p, "w154")!} alt="" loading="lazy" />)
                        ) : (
                          <IconList size={28} />
                        )}
                      </div>
                      <span className="list-name">{l.name}</span>
                      <span className="mono list-count">
                        {l.count} {l.count === 1 ? "title" : "titles"}
                      </span>
                    </Link>
                  ))}
                </div>
              </>
            )}
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
