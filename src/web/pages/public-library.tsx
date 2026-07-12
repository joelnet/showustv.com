// The public, read-only library at /u/:username/library (issue #245): the
// same Shows / Movies / Anime views as the owner's Library — literally the
// same components (library.tsx) over the same server-side payload shape —
// with the username up top so it's unmistakably theirs, and no Watch Later
// content (planning is private; no public surface shows it — the payload
// carries those buckets only when explicitly requested, and this page's
// endpoint never asks). Works signed in or out:
// profiles are shareable, and the profile's history-row headings land here.
//
// Visibility is the profile's, nothing more and nothing less (no separate
// toggle): the server applies the same gate as /u/:username (issues
// #158/#184), so a private profile serves the same teaser here — owner and
// mutual follows see it in full, everyone else gets the lock. The server
// decides; this page just renders what it's sent.
import { useEffect } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useApi, useDocumentTitle, dropCached } from "../hooks";
import { useAuth } from "../app";
import { Empty, SmpteBars } from "../components/ui";
import { PosterGridSkeleton } from "../components/skeleton";
import { IconLock } from "../components/icons";
import { ShowsLibrary, MovieGrid, AnimeLibrary, type LibShow, type LibMovie } from "./library";

interface FullLibrary {
  username: string;
  // True when a private profile's library is served in full — to the owner
  // or a mutual follow (issue #184).
  private?: boolean;
  shows: LibShow[];
  movies: LibMovie[];
  animeShows: LibShow[];
  animeMovies: LibMovie[];
}

// What a private profile serves to everyone else — same teaser as the
// profile endpoint (issue #158). `shows` is the discriminant.
interface LibraryTeaser {
  username: string;
  private: true;
  shows?: undefined;
}

type PublicLibrary = FullLibrary | LibraryTeaser;

export function PublicLibraryPage({ tab }: { tab: "shows" | "movies" | "anime" }) {
  const { username } = useParams();
  const { user } = useAuth();
  const path = `/public/library/${encodeURIComponent(username!)}`;
  const { data, loading, error } = useApi<PublicLibrary>(path);

  useDocumentTitle(data && `@${data.username} · Library`);

  // Cache hygiene mirrored from public-profile.tsx: a private library served
  // in full is no-store on the wire; drop the in-memory copy too so it can't
  // warm-paint after access is revoked.
  useEffect(() => {
    if (data?.shows && data.private) dropCached(path);
  }, [data, path]);

  // Movie watched-at timestamps render in the VIEWER's timezone: the
  // signed-in viewer's saved tz, or the browser's for anonymous visitors.
  const tz = user?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (loading) return <PosterGridSkeleton />;
  if (error || !data)
    return (
      <div className="empty">
        <SmpteBars />
        <h3>Nothing to see here</h3>
        <p>This profile doesn&rsquo;t exist.</p>
      </div>
    );

  // Private teaser — same face the profile page shows (issue #158).
  if (!data.shows)
    return (
      <>
        <h1 className="page-title">{data.username}</h1>
        <div className="empty">
          <IconLock size={26} />
          <h3>This profile is private</h3>
          <p>Only {data.username} can see what&rsquo;s on it.</p>
        </div>
      </>
    );

  const base = `/u/${data.username}/library`;
  return (
    <div>
      <Link to={`/u/${data.username}`} className="crumb">‹ {data.username}</Link>
      {/* The username in the title is the point (issue #245): this page looks
          like the Library, so it must say whose library it is. */}
      <h1 className="page-title">{data.username}&rsquo;s Library</h1>
      <nav className="tabs" aria-label="Library sections">
        <NavLink to={base} end>Shows</NavLink>
        <NavLink to={`${base}/movies`}>Movies</NavLink>
        <NavLink to={`${base}/anime`}>Anime</NavLink>
      </nav>

      {tab === "shows" &&
        (!data.shows.length ? (
          <Empty title="No shows here yet" hint={`Shows ${data.username} is watching, up to date on, finished, or abandoned will show up here.`} />
        ) : (
          <ShowsLibrary
            shows={data.shows}
            empty={
              <Empty
                title="No shows here yet"
                hint={`Shows ${data.username} is watching, up to date on, finished, or abandoned will show up here.`}
              />
            }
          />
        ))}

      {tab === "movies" &&
        (!data.movies.length ? (
          <Empty title="No movies here yet" hint={`Movies ${data.username} watches will land here.`} />
        ) : (
          <MovieGrid movies={data.movies} tz={tz} />
        ))}

      {tab === "anime" &&
        (!data.animeShows.length && !data.animeMovies.length ? (
          <Empty title="No anime here yet" hint={`Anime ${data.username} watches will land here.`} />
        ) : (
          <AnimeLibrary shows={data.animeShows} movies={data.animeMovies} tz={tz} />
        ))}
    </div>
  );
}
