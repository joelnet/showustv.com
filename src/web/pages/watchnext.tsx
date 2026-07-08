import { Link, Navigate, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { poster, backdrop, still } from "../img";
import { Spinner, Empty, ErrorNote } from "../components/ui";
import { mediaPath } from "../paths";

// A tile for any home item — a show (with its next/last episode) or a movie.
interface HomeItem {
  kind: "show" | "movie";
  id: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  still: string | null;
  season?: number;
  number?: number;
  episodeTitle?: string | null;
  count?: number;
}

interface HomeData {
  continueWatching: HomeItem[];
  startWatching: HomeItem[];
  upcoming: HomeItem[];
  havenWatched: HomeItem[];
  history: HomeItem[];
}

type SectionKey = "continue" | "start" | "upcoming" | "haven" | "history";

const SECTIONS: { key: SectionKey; label: string; field: keyof HomeData }[] = [
  { key: "continue", label: "Continue Watching", field: "continueWatching" },
  { key: "start", label: "Start Watching", field: "startWatching" },
  { key: "upcoming", label: "Upcoming", field: "upcoming" },
  { key: "haven", label: "Haven't Watched in a While", field: "havenWatched" },
  { key: "history", label: "History", field: "history" },
];

// The whole tile links to the show/movie; watch actions happen there (#106).
// Landscape thumbnail, bold title, and one muted "S1·E3 - Episode title" line.
function Tile({ item }: { item: HomeItem }) {
  const thumb = still(item.still) ?? backdrop(item.backdrop) ?? poster(item.poster);
  return (
    <Link to={mediaPath(item.kind, item.id, item.title)} className="wn-tile">
      <div className="wn-tile-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="poster-fallback">{item.title}</div>}
        {item.count != null && item.count > 0 && <span className="pill wn-tile-count">{item.count} left</span>}
      </div>
      <div className="wn-tile-body">
        <span className="wn-tile-show">{item.title}</span>
        {item.season != null && item.number != null && (
          <span className="wn-tile-ep">
            S{item.season}·E{item.number}
            {item.episodeTitle ? ` - ${item.episodeTitle}` : ""}
          </span>
        )}
      </div>
    </Link>
  );
}

// Home: horizontally-scrollable rows (issue #105), one per section, each with a
// clickable header that opens the full list for that section.
export function WatchNext() {
  const { data, loading, error } = useApi<HomeData>("/home");
  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const rows = SECTIONS.map((s) => ({ ...s, items: data[s.field] ?? [] })).filter((s) => s.items.length > 0);
  if (rows.length === 0) {
    return (
      <>
        <h1 className="sr-only">Watch</h1>
        <Empty
          title="Nothing on deck"
          hint="Follow a show and its next episode lands here. Try the search, or start with what's trending."
        />
      </>
    );
  }

  return (
    <div className="wn-home">
      <h1 className="sr-only">Watch</h1>
      {rows.map((s) => (
        <section key={s.key} className="wn-section">
          <Link to={`/watch/${s.key}`} className="wn-section-head">
            <h2>{s.label}</h2>
            <span className="wn-section-more" aria-hidden="true">›</span>
          </Link>
          <div className="wn-row">
            {s.items.map((it, i) => (
              <Tile key={`${it.kind}-${it.id}-${i}`} item={it} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// The "list view for that type" behind each section header (#105): the full
// section as a poster grid.
export function WatchSectionPage() {
  const { key } = useParams();
  const section = SECTIONS.find((s) => s.key === key);
  const { data, loading, error } = useApi<HomeData>(section ? "/home" : null);
  if (!section) return <Navigate to="/" replace />;
  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const items = data[section.field] ?? [];
  return (
    <div>
      <Link to="/" className="crumb">‹ Watch</Link>
      <h1 className="page-title">{section.label}</h1>
      {items.length === 0 ? (
        <Empty title="Nothing here yet" hint="Come back once you've got shows in this bucket." />
      ) : (
        <div className="wn-grid">
          {items.map((it, i) => (
            <Tile key={`${it.kind}-${it.id}-${i}`} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}
