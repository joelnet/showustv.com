import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "../app";
import { useApi } from "../hooks";
import { post } from "../api";
import { poster, backdrop, still } from "../img";
import { epCode, fmtMonthDay } from "../format";
import { Empty, ErrorNote, CheckButton } from "../components/ui";
import { IconEye, IconEyeSlash } from "../components/icons";
import { HomeSkeleton, TileGridSkeleton } from "../components/skeleton";
import { useCelebrate } from "../components/celebration";
import { mediaPath } from "../paths";
import { precacheContinueWatching } from "../precache";

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
  // The exact episode behind the tile: what a followee watched on friends
  // tiles (issue #128), the next-up episode on the queue sections' tiles —
  // there it's what the mark-watched button marks (issue #186).
  episodeId?: number | null;
  airDate?: string | null; // Upcoming tiles: the episode's air date, 'YYYY-MM-DD' (issue #175)
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
// your followees watched recently, each credited to the watcher and naming
// the exact episode they reached.
const SECTIONS: { key: SectionKey; label: string; field: keyof HomeData }[] = [
  { key: "continue", label: "Continue Watching", field: "continueWatching" },
  { key: "upcoming", label: "Upcoming", field: "upcoming" },
  { key: "haven", label: "Haven't Watched in a While", field: "havenWatched" },
  { key: "notstarted", label: "Not Started", field: "notStarted" },
  { key: "history", label: "History", field: "history" },
  { key: "friends", label: "From People You Follow", field: "friendsWatched" },
];

// The queue sections: their tiles name the user's exact next-up episode, so
// they carry a mark-watched check button (issue #186). The other sections
// don't — Upcoming episodes haven't aired, History is already watched, and
// friends tiles track someone else's viewing.
const MARKABLE_SECTIONS: ReadonlySet<SectionKey> = new Set(["continue", "haven", "notstarted"]);

// Sections the user has hidden on Watch Now (issue #185), persisted per user
// so two accounts on the same browser keep separate layouts. A per-device UI
// preference, so localStorage is the right home (no API round-trip; the
// tradeoff is it doesn't follow the account to other devices). Keyed by the
// stable section keys above — the same ones the /watch/:key routes use —
// never by index or display label, so reordering or renaming sections can't
// scramble a saved layout.
const hiddenSectionsKey = (userId: number) => `watchnext-hidden-sections:${userId}`;

function loadHiddenSections(userId: number | undefined): Set<SectionKey> {
  if (userId == null) return new Set();
  try {
    const raw = localStorage.getItem(hiddenSectionsKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    // Drop anything that isn't a known section key — a stale or tampered
    // entry must not survive into state and get written back on next toggle.
    const known = new Set<string>(SECTIONS.map((s) => s.key));
    return new Set(parsed.filter((k): k is SectionKey => typeof k === "string" && known.has(k)));
  } catch {
    return new Set(); // storage disabled or corrupt — every section stays visible
  }
}

function saveHiddenSections(userId: number | undefined, hidden: Set<SectionKey>): void {
  if (userId == null) return;
  try {
    localStorage.setItem(hiddenSectionsKey(userId), JSON.stringify([...hidden]));
  } catch {
    // storage disabled/full — the toggle still works for this visit
  }
}

// The thumbnail and titles link to the show/movie; watch actions happen there
// (#106). Landscape thumbnail, bold title, and one muted "S02·E05 - Episode
// title" line — the episode code uses the shared epCode slate format; the
// " - " separator stays the tile convention (#106). Friend-watched
// tiles add a "Watched by <user>" line whose username links to that person's
// profile — a separate sibling link, since anchors can't nest (issue #128) —
// and their media link goes to the exact episode the followee watched, so
// tracking their progress is one tap (issue #128 follow-up); the queue
// sections' tiles carry an episodeId too now (issue #186) but keep linking
// to the show, where the full watch flow lives (#106). Missing episode
// fields degrade to the plain show link. Upcoming tiles carry an airDate and
// wear it as a "Jan 17"-style pill on the thumb (issue #175), in the corner
// the count pill uses elsewhere — the two never appear on the same tile.
//
// `markable` tiles (the queue sections, issue #186) get the app's check
// button on the right edge of the tile body, marking exactly the next-up
// episode the tile names. It sits OUTSIDE .wn-tile-link in the DOM —
// interactive content can't nest inside an anchor, and as a sibling its
// click can never bubble into the Link and navigate — and is absolutely
// positioned over the body's right edge (the body reserves padding so text
// never runs under it). The check flips green immediately; the response
// then steers the update: queued offline it stays put (the post-sync
// revalidation will refresh /home), online `onWatched` refetches /home so
// the tile advances to the next episode or the show leaves the section.
function Tile({ item, markable, onWatched }: { item: HomeItem; markable?: boolean; onWatched?: () => void }) {
  const celebrate = useCelebrate();
  // The episode id this tile has optimistically marked watched — compared
  // against item.episodeId so the check unwinds by itself when fresh data
  // advances the tile to the next episode.
  const [markedId, setMarkedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const thumb = still(item.still) ?? backdrop(item.backdrop) ?? poster(item.poster);
  const to =
    item.username && item.episodeId != null && item.season != null && item.number != null
      ? mediaPath("episode", item.episodeId, item.episodeTitle)
      : mediaPath(item.kind, item.id, item.title);
  const canMark = markable === true && item.episodeId != null;
  const checked = item.episodeId != null && markedId === item.episodeId;

  // Fresh /home data that still names the same episode means the mark never
  // landed — the queued op was dropped on replay (4xx / cross-account). A
  // mark that landed always advances episodeId, so unwind the optimistic
  // check rather than let it lie. Identity-keyed: cached re-paints hand back
  // the same object, so this fires only when a fetch actually parsed new
  // data. Skipped while the POST is in flight (a connectivity-flap
  // revalidation mustn't unwind a mark that's about to succeed).
  useEffect(() => {
    if (!busy) setMarkedId(null);
    // Deliberately keyed on item identity alone: a busy flip must not unwind
    // the check while the tile still shows pre-mutation data.
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  const markWatched = async () => {
    const episodeId = item.episodeId;
    if (episodeId == null || busy || checked) return; // already marked — undo lives on the episode/show page
    setBusy(true);
    setMarkedId(episodeId); // optimistic — the button reads watched right away
    try {
      const r = await post(`/episodes/${episodeId}/watch`);
      // Queued offline: keep the optimistic check; refetching now would only
      // serve the stale pre-change cache. The offline queue's post-sync
      // revalidation refreshes /home once the mark lands (issue #183).
      if (!r?.queued) onWatched?.();
      // Same catch-up confetti as the episode/show pages (issue #53).
      if (r?.caughtUp) celebrate(r.showTitle ?? item.title);
    } catch {
      setMarkedId(null); // rejected — unwind the optimistic check
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wn-tile">
      <Link to={to} className="wn-tile-link" draggable={false}>
        <div className="wn-tile-thumb">
          {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="poster-fallback">{item.title}</div>}
          {item.count != null && item.count > 0 && <span className="pill wn-tile-count">{item.count} left</span>}
          {item.airDate && <span className="pill wn-tile-date">{fmtMonthDay(item.airDate)}</span>}
        </div>
        <div className={canMark ? "wn-tile-body has-check" : "wn-tile-body"}>
          <span className="wn-tile-show">{item.title}</span>
          {item.season != null && item.number != null && (
            <span className="wn-tile-ep">
              {epCode(item.season, item.number)}
              {item.episodeTitle ? ` - ${item.episodeTitle}` : ""}
            </span>
          )}
        </div>
      </Link>
      {canMark && (
        <span className="wn-tile-check">
          {/* The show title in the label keeps repeated buttons apart for
              screen-reader button navigation. Disabled once checked: the
              mark is one-way here — undo lives on the episode/show page. */}
          <CheckButton
            checked={checked}
            disabled={busy || checked}
            label={
              checked
                ? `Marked ${item.title} watched`
                : item.season != null && item.number != null
                  ? `Mark ${item.title} ${epCode(item.season, item.number)} watched`
                  : `Mark ${item.title} watched`
            }
            onToggle={markWatched}
          />
        </span>
      )}
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
function Row({ items, markable, onWatched }: { items: HomeItem[]; markable?: boolean; onWatched?: () => void }) {
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
        <Tile key={`${it.kind}-${it.id}-${i}`} item={it} markable={markable} onWatched={onWatched} />
      ))}
    </div>
  );
}

// Home: horizontally-scrollable rows (issue #105), one per section, each with a
// clickable header that opens the full list for that section. Each section
// header also carries an eye toggle at the far right (issue #185): hiding a
// section collapses its row and sinks the whole section to the bottom of the
// page — visible sections keep their normal order up top, hidden ones sit
// below in their original relative order, no divider between the two. A
// hidden section keeps its header and toggle so it can be restored.
export function WatchNext() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<HomeData>("/home");
  const [hidden, setHidden] = useState<Set<SectionKey>>(() => loadHiddenSections(user?.id));

  // While online, warm the offline cache for the Continue Watching shows so
  // tapping one of these tiles still works in airplane mode (issue #139).
  useEffect(() => {
    if (data?.continueWatching?.length) precacheContinueWatching(data.continueWatching);
  }, [data]);

  if (loading) return <HomeSkeleton />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  function toggleHidden(key: SectionKey) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHidden(next);
    saveHiddenSections(user?.id, next);
  }

  // Empty sections never render (so they never get a toggle); hidden ones
  // sink below the visible ones (issue #185).
  const sections = SECTIONS.map((s) => ({ ...s, items: data[s.field] ?? [] })).filter((s) => s.items.length > 0);
  const rows = [...sections.filter((s) => !hidden.has(s.key)), ...sections.filter((s) => hidden.has(s.key))];
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
      {rows.map((s) => {
        const isHidden = hidden.has(s.key);
        return (
          <section key={s.key} className={isHidden ? "wn-section is-hidden" : "wn-section"}>
            <div className="wn-section-bar">
              <Link to={`/watch/${s.key}`} className="wn-section-head">
                <h2>{s.label}</h2>
                <span className="wn-section-more" aria-hidden="true">›</span>
              </Link>
              <button
                type="button"
                className="btn btn-ghost wn-section-toggle"
                aria-expanded={!isHidden}
                aria-label={isHidden ? `Show ${s.label}` : `Hide ${s.label}`}
                title={isHidden ? `Show ${s.label}` : `Hide ${s.label}`}
                onClick={() => toggleHidden(s.key)}
              >
                {isHidden ? <IconEyeSlash size={15} /> : <IconEye size={15} />}
              </button>
            </div>
            {!isHidden && <Row items={s.items} markable={MARKABLE_SECTIONS.has(s.key)} onWatched={reload} />}
          </section>
        );
      })}
    </div>
  );
}

// The "list view for that type" behind each section header (#105): the full
// section as a poster grid.
export function WatchSectionPage() {
  const { key } = useParams();
  const section = SECTIONS.find((s) => s.key === key);
  const { data, loading, error, reload } = useApi<HomeData>(section ? "/home" : null);

  // Same offline warming as the home page — /watch/* section pages load the
  // same /home payload, so a deep link here precaches Continue Watching too.
  useEffect(() => {
    if (data?.continueWatching?.length) precacheContinueWatching(data.continueWatching);
  }, [data]);

  if (!section) return <Navigate to="/" replace />;
  // The crumb and title are static — render them for real during the load so
  // only the grid is skeletal.
  if (loading)
    return (
      <div>
        <Link to="/" className="crumb">‹ Watch</Link>
        <h1 className="page-title">{section.label}</h1>
        <TileGridSkeleton />
      </div>
    );
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
            <Tile key={`${it.kind}-${it.id}-${i}`} item={it} markable={MARKABLE_SECTIONS.has(section.key)} onWatched={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
