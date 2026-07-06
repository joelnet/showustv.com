import { useEffect, useState, type KeyboardEvent } from "react";
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

// Upcoming episodes reuse the Watch Now tile shape (poster + body) but lead
// with the air date and drop the mark/count chrome, since nothing here has
// aired yet.
function UpcomingTile({ item, tz }: { item: UpcomingItem; tz: string }) {
  const src = poster(item.poster);
  return (
    <article className="wn-tile wn-tile--upcoming">
      <Link to={mediaPath("show", item.showId, item.showTitle)} className="wn-tile-poster">
        {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{item.showTitle}</div>}
      </Link>
      <div className="wn-tile-body">
        <span className="wn-tile-date mono">{fmtAirDate(item.airDate, tz)}</span>
        <Link to={mediaPath("show", item.showId, item.showTitle)} className="wn-tile-show">{item.showTitle}</Link>
        <div className="wn-tile-ep">
          <Slate season={item.season} number={item.number} />
          <Link to={mediaPath("episode", item.episodeId, item.title)}>{item.title ?? `Episode ${item.number}`}</Link>
        </div>
      </div>
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
  const [tab, setTab] = useState<"now" | "upcoming">("now");
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
  // The backend already returns one soonest episode per show; dedupe again
  // defensively so a stale cache can't surface the same show twice.
  const seenShows = new Set<number>();
  const upcoming = (data?.upcoming ?? []).filter((u) =>
    seenShows.has(u.showId) ? false : (seenShows.add(u.showId), true)
  );
  const tz = user!.tz;

  // Full ARIA tabs keyboard support: Arrow/Home/End move selection and focus
  // between the two tabs (selection follows focus — switching is cheap).
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const order = ["now", "upcoming"] as const;
    const i = order.indexOf(tab);
    let next: (typeof order)[number] | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = order[(i + order.length - 1) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`wn-tab-${next}`)?.focus();
  }

  return (
    <div>
      <h1 className="sr-only">Watch Now</h1>
      <div className="wn-tabs" role="tablist" aria-label="Watch Now and Upcoming">
        <button
          type="button"
          role="tab"
          id="wn-tab-now"
          aria-selected={tab === "now"}
          aria-controls="wn-panel-now"
          className={`wn-tab${tab === "now" ? " is-active" : ""}`}
          tabIndex={tab === "now" ? 0 : -1}
          onClick={() => setTab("now")}
          onKeyDown={onTabKeyDown}
        >
          Watch Now
        </button>
        <button
          type="button"
          role="tab"
          id="wn-tab-upcoming"
          aria-selected={tab === "upcoming"}
          aria-controls="wn-panel-upcoming"
          className={`wn-tab${tab === "upcoming" ? " is-active" : ""}`}
          tabIndex={tab === "upcoming" ? 0 : -1}
          onClick={() => setTab("upcoming")}
          onKeyDown={onTabKeyDown}
        >
          Upcoming
        </button>
      </div>

      {tab === "now" ? (
        <div id="wn-panel-now" role="tabpanel" aria-labelledby="wn-tab-now">
          {current.length > 0 ? (
            <div className="wn-grid">
              {current.map((item) => (
                <Tile key={item.show.id} item={item} tz={tz} marking={marking} onMark={markWatched} />
              ))}
            </div>
          ) : (
            <Empty
              title="Nothing on deck"
              hint="Follow a show and its next episode lands here. Try the search, or start with what's trending."
            />
          )}
        </div>
      ) : (
        <div id="wn-panel-upcoming" role="tabpanel" aria-labelledby="wn-tab-upcoming">
          {upcoming.length > 0 ? (
            <div className="wn-grid">
              {upcoming.map((u) => (
                <UpcomingTile key={u.showId} item={u} tz={tz} />
              ))}
            </div>
          ) : (
            <Empty
              title="Nothing scheduled"
              hint="Upcoming episodes of the shows you follow will show up here."
            />
          )}
        </div>
      )}
    </div>
  );
}
