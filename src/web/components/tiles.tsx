// The Watch Now tile row, extracted from watchnext.tsx so other pages can
// reuse the exact same look (issue #245: the profile's Shows / Movies / Anime
// history rows). A TileItem is one landscape tile — a show (usually with an
// episode slate) or a movie; Row is the drag-scrollable horizontal strip of
// them; TileSection wraps a Row in the Watch Now section chrome: the linked
// heading (h2 + chevron) that opens the fuller page behind the row.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api";
import { poster, backdrop, still } from "../img";
import { epCode, fmtMonthDay } from "../format";
import { CheckButton } from "./ui";
import { useCelebrate } from "./celebration";
import { mediaPath } from "../paths";

// A tile for any media item — a show (with its next/last episode) or a movie.
export interface TileItem {
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
export function Tile({ item, markable, onWatched }: { item: TileItem; markable?: boolean; onWatched?: () => void }) {
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

// Click-and-drag horizontal scrolling for the tile rows on desktop, matching
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

// The bare horizontal scroller: a .wn-row strip of whatever the caller puts
// in it, drag-scrollable on desktop. Row feeds it Tiles; the profile's Stats
// slider (issue #250) feeds it stat cards — one scroller, so the drag/click
// behavior can never fork between them.
export function ScrollRow({ children }: { children: React.ReactNode }) {
  const drag = useDragScroll<HTMLDivElement>();
  return (
    <div
      className="wn-row"
      ref={drag.ref}
      onMouseDown={drag.onMouseDown}
      onClickCapture={drag.onClickCapture}
      onDragStart={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

// One section's horizontal row of tiles, drag-scrollable on desktop.
export function Row({ items, markable, onWatched }: { items: TileItem[]; markable?: boolean; onWatched?: () => void }) {
  return (
    <ScrollRow>
      {items.map((it, i) => (
        <Tile key={`${it.kind}-${it.id}-${i}`} item={it} markable={markable} onWatched={onWatched} />
      ))}
    </ScrollRow>
  );
}

// A ScrollRow of arbitrary children in the Watch Now section chrome (issue
// #105): the heading bar over the strip. With `to` the heading is itself the
// link — h2 plus a chevron — opening the fuller page behind the row; without
// it the heading is plain text (the profile's Stats slider, issue #250, has
// no page behind it).
export function SliderSection({ title, to, className, children }: { title: string; to?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={className ? `wn-section ${className}` : "wn-section"}>
      <div className="wn-section-bar">
        {to ? (
          <Link to={to} className="wn-section-head">
            <h2>{title}</h2>
            <span className="wn-section-more" aria-hidden="true">›</span>
          </Link>
        ) : (
          <div className="wn-section-head is-static">
            <h2>{title}</h2>
          </div>
        )}
      </div>
      <ScrollRow>{children}</ScrollRow>
    </section>
  );
}

// Tiles in the section chrome. An empty section renders nothing, heading
// included, so pages composing several of these never show a bar with no
// tiles under it (issue #245).
export function TileSection({ title, to, items }: { title: string; to: string; items: TileItem[] }) {
  if (items.length === 0) return null;
  return (
    <SliderSection title={title} to={to}>
      {items.map((it, i) => (
        <Tile key={`${it.kind}-${it.id}-${i}`} item={it} />
      ))}
    </SliderSection>
  );
}
