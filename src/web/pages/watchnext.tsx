import { useEffect, useRef } from "react";
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
  username?: string; // "From People You Follow": who watched it (issue #128)
}

interface HomeData {
  continueWatching: HomeItem[];
  upcoming: HomeItem[];
  havenWatched: HomeItem[];
  notStarted: HomeItem[];
  history: HomeItem[];
  friendsWatched: HomeItem[];
}

type SectionKey = "continue" | "upcoming" | "haven" | "notstarted" | "history" | "friends";

// "Not Started" (shows you follow but haven't begun) sits just above History —
// the Library no longer carries it or "Watching" (issue #115); Watch Next owns
// those now. "From People You Follow" (issue #128) anchors the bottom: shows
// your followees watched recently, each credited to the watcher.
const SECTIONS: { key: SectionKey; label: string; field: keyof HomeData }[] = [
  { key: "continue", label: "Continue Watching", field: "continueWatching" },
  { key: "upcoming", label: "Upcoming", field: "upcoming" },
  { key: "haven", label: "Haven't Watched in a While", field: "havenWatched" },
  { key: "notstarted", label: "Not Started", field: "notStarted" },
  { key: "history", label: "History", field: "history" },
  { key: "friends", label: "From People You Follow", field: "friendsWatched" },
];

// The thumbnail and titles link to the show/movie; watch actions happen there
// (#106). Landscape thumbnail, bold title, and one muted "S1·E3 - Episode
// title" line. Friend-watched tiles add a "Watched by <user>" line whose
// username links to that person's profile — a separate sibling link, since
// anchors can't nest (issue #128).
function Tile({ item }: { item: HomeItem }) {
  const thumb = still(item.still) ?? backdrop(item.backdrop) ?? poster(item.poster);
  return (
    <div className="wn-tile">
      <Link to={mediaPath(item.kind, item.id, item.title)} className="wn-tile-link" draggable={false}>
        <div className="wn-tile-thumb">
          {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="poster-fallback">{item.title}</div>}
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
      {item.username && (
        <span className="wn-tile-ep wn-tile-user">
          Watched by{" "}
          <Link to={`/u/${item.username}`} draggable={false}>
            {item.username}
          </Link>
        </span>
      )}
    </div>
  );
}

// Click-and-drag horizontal scrolling for the section rows on desktop, matching
// the native touch-drag that already works on mobile (issue #114). Once a drag
// moves past a few pixels it also swallows the click, so releasing on a tile
// scrolls the row instead of navigating into the show.
function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const state = useRef({ down: false, startX: 0, startLeft: 0, moved: false, suppressClick: false });

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // primary button only
    const el = ref.current;
    if (!el) return;
    const s = state.current;
    s.down = true;
    s.startX = e.pageX;
    s.startLeft = el.scrollLeft;
    s.moved = false;
    el.classList.add("is-grabbing");
  };

  // Capture phase so we can cancel the click before it reaches the tile Link.
  const onClickCapture = (e: React.MouseEvent) => {
    if (state.current.suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      state.current.suppressClick = false;
    }
  };

  useEffect(() => {
    // Track the drag on window so it keeps scrolling if the cursor leaves the row.
    const onMove = (e: MouseEvent) => {
      const s = state.current;
      const el = ref.current;
      if (!s.down || !el) return;
      const dx = e.pageX - s.startX;
      if (Math.abs(dx) > 5) s.moved = true;
      el.scrollLeft = s.startLeft - dx;
      e.preventDefault(); // suppress text selection while dragging
    };
    const onUp = () => {
      const s = state.current;
      if (!s.down) return;
      s.down = false;
      ref.current?.classList.remove("is-grabbing");
      if (s.moved) {
        // Swallow only the click this drag is about to emit, then clear on the
        // next tick so a later keyboard/Enter click on a tile still navigates
        // (a keyboard click has no preceding mousedown to reset the flag).
        s.suppressClick = true;
        setTimeout(() => {
          s.suppressClick = false;
        }, 0);
      }
      s.moved = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return { ref, onMouseDown, onClickCapture };
}

// One section's horizontal row of tiles, drag-scrollable on desktop.
function Row({ items }: { items: HomeItem[] }) {
  const drag = useDragScroll<HTMLDivElement>();
  return (
    <div
      className="wn-row"
      ref={drag.ref}
      onMouseDown={drag.onMouseDown}
      onClickCapture={drag.onClickCapture}
      onDragStart={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <Tile key={`${it.kind}-${it.id}-${i}`} item={it} />
      ))}
    </div>
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
          <Row items={s.items} />
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
