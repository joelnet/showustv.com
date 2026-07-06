import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { post } from "../api";
import { useAuth } from "../app";
import { poster } from "../img";
import { fmtAirDate } from "../format";
import { Slate, Spinner, Empty, ErrorNote } from "../components/ui";
import { useCelebrate } from "../components/celebration";
import { IconCheck } from "../components/icons";
import { mediaPath } from "../paths";

interface UpcomingItem {
  episodeId: number;
  showId: number;
  showTitle: string;
  poster: string | null;
  season: number;
  number: number;
  title: string | null;
  airDate: string;
}

interface WatchNextItem {
  show: { id: number; title: string; poster: string | null; backdrop: string | null };
  episode: {
    id: number;
    season: number;
    number: number;
    title: string | null;
    airDate: string | null;
    runtime: number | null;
    still: string | null;
  };
  unwatchedCount: number;
  lastActivity: string;
}

function Tile({
  item,
  tz,
  marking,
  onMark,
}: {
  item: WatchNextItem;
  tz: string;
  marking: boolean;
  onMark: (episodeId: number) => void;
}) {
  const src = poster(item.show.poster);
  return (
    <article className="wn-tile">
      <Link to={mediaPath("show", item.show.id, item.show.title)} className="wn-tile-poster">
        {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{item.show.title}</div>}
        <span className="pill wn-tile-count">{item.unwatchedCount} left</span>
      </Link>
      <div className="wn-tile-body">
        <Link to={mediaPath("show", item.show.id, item.show.title)} className="wn-tile-show">{item.show.title}</Link>
        <div className="wn-tile-ep">
          <Slate season={item.episode.season} number={item.episode.number} />
          <Link to={mediaPath("episode", item.episode.id, item.episode.title)}>{item.episode.title ?? `Episode ${item.episode.number}`}</Link>
        </div>
        <span className="wn-tile-date mono">{fmtAirDate(item.episode.airDate, tz)}</span>
      </div>
      <button
        className="btn btn-mark wn-tile-btn"
        onClick={() => onMark(item.episode.id)}
        disabled={marking}
        aria-label={`Mark ${item.show.title} S${item.episode.season} E${item.episode.number} watched`}
      >
        <IconCheck size={14} /> <span>Watched</span>
      </button>
    </article>
  );
}

export function WatchNext() {
  const { user } = useAuth();
  const celebrate = useCelebrate();
  const { data, loading, error, reload } = useApi<{
    watchNext: WatchNextItem[];
    upcoming: UpcomingItem[];
  }>("/watch-next");
  const [marking, setMarking] = useState(false);
  // Episodes whose watch is queued offline — hidden locally, since a
  // refetch would just serve the stale pre-change cache and resurrect them.
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  useEffect(() => setHidden(new Set()), [data]); // fresh data supersedes the overlay

  async function markWatched(episodeId: number) {
    setMarking(true);
    try {
      const r = await post(`/episodes/${episodeId}/watch`);
      // Queued offline: hide the tile optimistically; the post-sync
      // revalidation refetches the real list.
      if (r?.queued) setHidden((h) => new Set(h).add(episodeId));
      else reload();
      // Server flags when this was the show's last unwatched episode (issue #53).
      if (r?.caughtUp) celebrate(r.showTitle);
    } finally {
      setMarking(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  const current = (data?.watchNext ?? []).filter((i) => !hidden.has(i.episode.id));
  const upcoming = data?.upcoming ?? [];
  const tz = user!.tz;

  return (
    <div>
      <h1 className="page-title">Watch now</h1>

      {!current.length && !upcoming.length ? (
        <Empty
          title="Nothing on deck"
          hint="Follow a show and its next episode lands here. Try the search, or start with what's trending."
        />
      ) : (
        <>
          {current.length > 0 && (
            <div className="wn-grid">
              {current.map((item) => (
                <Tile key={item.show.id} item={item} tz={tz} marking={marking} onMark={markWatched} />
              ))}
            </div>
          )}

          {upcoming.length > 0 && (
            <>
              <h2 className="section-title wn-divider">Upcoming</h2>
              <ul className="agenda">
                {upcoming.map((u) => (
                  <li key={u.episodeId}>
                    <span className="mono agenda-date">{fmtAirDate(u.airDate, tz)}</span>
                    <Link to={mediaPath("show", u.showId, u.showTitle)} className="agenda-show">{u.showTitle}</Link>
                    <Slate season={u.season} number={u.number} />
                    <Link to={mediaPath("episode", u.episodeId, u.title)} className="agenda-ep">
                      {u.title ?? `Episode ${u.number}`}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

        </>
      )}
    </div>
  );
}
