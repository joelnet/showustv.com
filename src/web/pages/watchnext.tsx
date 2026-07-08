import { useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { poster, backdrop, still } from "../img";
import { Spinner, Empty, ErrorNote } from "../components/ui";
import { mediaPath } from "../paths";

interface UpcomingItem {
  episodeId: number;
  showId: number;
  showTitle: string;
  poster: string | null;
  backdrop: string | null;
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

// The whole tile links to the show; watch actions happen on the show page
// (issue #106). Landscape thumbnail (episode still, else show backdrop), a
// bold show title, and one muted "S1·E3 - Episode title" line.
function Tile({ item }: { item: WatchNextItem }) {
  const ep = item.episode;
  const thumb = still(ep.still) ?? backdrop(item.show.backdrop);
  return (
    <Link to={mediaPath("show", item.show.id, item.show.title)} className="wn-tile">
      <div className="wn-tile-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="poster-fallback">{item.show.title}</div>}
        <span className="pill wn-tile-count">{item.unwatchedCount} left</span>
      </div>
      <div className="wn-tile-body">
        <span className="wn-tile-show">{item.show.title}</span>
        <span className="wn-tile-ep">
          S{ep.season}·E{ep.number}
          {ep.title ? ` - ${ep.title}` : ""}
        </span>
      </div>
    </Link>
  );
}

// Upcoming episodes reuse the same tile shape, minus the "N left" count.
function UpcomingTile({ item }: { item: UpcomingItem }) {
  const thumb = backdrop(item.backdrop) ?? poster(item.poster);
  return (
    <Link to={mediaPath("show", item.showId, item.showTitle)} className="wn-tile wn-tile--upcoming">
      <div className="wn-tile-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="poster-fallback">{item.showTitle}</div>}
      </div>
      <div className="wn-tile-body">
        <span className="wn-tile-show">{item.showTitle}</span>
        <span className="wn-tile-ep">
          S{item.season}·E{item.number}
          {item.title ? ` - ${item.title}` : ""}
        </span>
      </div>
    </Link>
  );
}

export function WatchNext() {
  const { data, loading, error } = useApi<{
    watchNext: WatchNextItem[];
    upcoming: UpcomingItem[];
  }>("/watch-next");
  const [tab, setTab] = useState<"now" | "upcoming">("now");

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  const current = data?.watchNext ?? [];
  // The backend already returns one soonest episode per show; dedupe again
  // defensively so a stale cache can't surface the same show twice.
  const seenShows = new Set<number>();
  const upcoming = (data?.upcoming ?? []).filter((u) =>
    seenShows.has(u.showId) ? false : (seenShows.add(u.showId), true)
  );

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
                <Tile key={item.show.id} item={item} />
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
                <UpcomingTile key={u.showId} item={u} />
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
