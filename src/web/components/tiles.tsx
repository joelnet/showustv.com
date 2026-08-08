// The Watch Now tile row, extracted from watchnext.tsx so other pages can
// reuse the exact same look (the profile's Shows / Movies / Anime
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
import { IconRewatch } from "./icons";
import { ReactionButton } from "./reactions";
import { useCelebrate } from "./celebration";
import { mediaPath } from "../paths";

// A tile for any media item — a show (with its next/last episode) or a movie.
// Most sections render the landscape 16:9 thumb (episode still / show
// backdrop). `posterArt` tiles (Not Started) instead show the
// show's portrait poster — the app's key "show art" everywhere else (search,
// library, lists) — since an unstarted show is better sold by its poster than
// by a screenshot of an episode you haven't reached.
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
  username?: string; // "From People You Follow": who watched it
  // The exact episode behind the tile: what a followee watched on friends
  // tiles, the next-up episode on the queue sections' tiles —
  // there it's what the mark-watched button marks.
  episodeId?: number | null;
  airDate?: string | null; // Upcoming tiles: the episode's air date, 'YYYY-MM-DD'
  // A rewatch round (0043). On the queue sections' tiles it's the show's OPEN
  // round, and its presence means every number on the tile is round-scoped:
  // the episode named is the next one the ROUND is missing, and `count` is how
  // many the round has left. This is the whole TV Time payoff — a show you
  // finished years ago back in the queue, with its history untouched — so the
  // tile says so out loud with the ↻ ROUND 2 badge.
  //
  // On History tiles it's the round the play itself landed in (open or long
  // since closed), so a rerun is legible in the log instead of being
  // pixel-identical to a first watch — the diary marker Letterboxd puts on a
  // rewatch and Trakt puts in history.
  rewatch?: { round: number; startedAt?: string } | null;
  // History tiles only: how many episodes of this show were logged in ONE
  // action (a "Mark all watched" / "Mark season" sweep stamps them all with a
  // single timestamp). Absent unless it's more than one. A round finished the
  // documented way used to shove 30 identical tiles into the rail — one per
  // episode, all at the same instant — so the surface that answers "what did
  // I actually watch?" was wiped by the feature's own finishing move.
  episodes?: number;
  // Friends tiles (#20): total reactions on this activity, and the viewer's
  // own ('like' | 'love' | … from shared/reactions.ts, null when none).
  reactionCount?: number;
  myReaction?: string | null;
}

// The thumbnail and titles link to the show/movie; watch actions happen there.
// Landscape thumbnail, bold title, and one muted "S02·E05 - Episode
// title" line — the episode code uses the shared epCode slate format; the
// " - " separator stays the tile convention. Friend-watched
// tiles add an attribution line whose username links to that person's
// profile — a separate sibling link, since anchors can't nest — with no
// "Watched by" label (#20 dropped it to make room for the reaction control
// beside it; the link alone reads as attribution) —
// and their media link goes to the exact episode the followee watched, so
// tracking their progress is one tap; the queue
// sections' tiles carry an episodeId too now but keep linking
// to the show, where the full watch flow lives. Missing episode
// fields degrade to the plain show link. Upcoming tiles carry an airDate and
// wear it as a "Jan 17"-style pill on the thumb, in the corner
// the count pill uses elsewhere — the two never appear on the same tile.
// Friends tiles also carry the thumbs-up reaction control (#20), pinned to
// the tile's bottom-right exactly like the check below — a Link sibling,
// absolutely positioned, with the attribution line reserving right padding.
//
// `markable` tiles (the queue sections) get the app's check
// button on the right edge of the tile body, marking exactly the next-up
// episode the tile names. It sits OUTSIDE .wn-tile-link in the DOM —
// interactive content can't nest inside an anchor, and as a sibling its
// click can never bubble into the Link and navigate — and is absolutely
// positioned over the body's right edge (the body reserves padding so text
// never runs under it). The check flips green immediately; the response
// then steers the update: queued offline it stays put (the post-sync
// revalidation will refresh /home), online `onWatched` refetches /home so
// the tile advances to the next episode or the show leaves the section.
export function Tile({ item, markable, onWatched, posterArt }: { item: TileItem; markable?: boolean; onWatched?: () => void; posterArt?: boolean }) {
  const celebrate = useCelebrate();
  // The episode id this tile has optimistically marked watched — compared
  // against item.episodeId so the check unwinds by itself when fresh data
  // advances the tile to the next episode.
  const [markedId, setMarkedId] = useState<number | null>(null);
  // The tap that just closed the round. `item.rewatch` and `item.count` come
  // from /home, which is a refetch away (seconds, on a slow connection), and
  // until it lands they both describe a round that no longer exists — a tile
  // still flying the round badge and "1 left" over a green check. The mark
  // that closed the round is the one thing this component knows before the
  // server can tell it, so it acts on it: badge and count go immediately.
  const [roundDone, setRoundDone] = useState(false);
  const [busy, setBusy] = useState(false);
  // Poster-art tiles (Not Started) show the show's portrait poster;
  // every other section leads with the episode still, then the show backdrop,
  // and only falls back to the poster. A missing poster degrades to the same
  // .poster-fallback placeholder the app's other poster tiles use.
  const thumb = posterArt ? poster(item.poster) : still(item.still) ?? backdrop(item.backdrop) ?? poster(item.poster);
  const to =
    item.username && item.episodeId != null && item.season != null && item.number != null
      ? mediaPath("episode", item.episodeId, item.episodeTitle)
      : mediaPath(item.kind, item.id, item.title);
  // Poster-art tiles are solely about the show: an
  // unstarted show is always at S01E01, so the episode number/title line is
  // redundant, and the mark-watched check is dropped too — the user clicks
  // through to the show to start the first episode there. So poster tiles are
  // never markable and never render the episode meta line, regardless of the
  // section's markable/episode fields; only the poster + show name remain.
  const canMark = markable === true && item.episodeId != null && !posterArt;
  const checked = item.episodeId != null && markedId === item.episodeId;
  // Everything round-scoped on this tile, silenced the moment the round ends.
  const rewatch = roundDone ? null : item.rewatch;
  const count = roundDone ? null : item.count;

  // Fresh /home data that still names the same episode means the mark never
  // landed — the queued op was dropped on replay (4xx / cross-account). A
  // mark that landed always advances episodeId, so unwind the optimistic
  // check rather than let it lie. Identity-keyed: cached re-paints hand back
  // the same object, so this fires only when a fetch actually parsed new
  // data. Skipped while the POST is in flight (a connectivity-flap
  // revalidation mustn't unwind a mark that's about to succeed).
  useEffect(() => {
    if (!busy) {
      setMarkedId(null);
      // Fresh data speaks for itself: whatever it says about the round now
      // outranks what this tile inferred from the response.
      setRoundDone(false);
    }
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
      // revalidation refreshes /home once the mark lands.
      if (!r?.queued) onWatched?.();
      // Same catch-up confetti as the episode/show pages — and the same for a
      // tick that closes a rewatch round, which the server flags on any watch
      // route. Finishing a round from here is exactly as much of an
      // achievement as finishing it on the show page; it must not pass in
      // silence just because the last tap happened in the queue.
      //
      // One event, one announcement, and the SAME one the show page gives:
      // the round number turns the card into "Round 2 in the books.", which
      // is the only true sentence here — "you're all caught up, you've
      // watched every episode that's aired" is what you tell someone who
      // wasn't. (It used to fire the caught-up card AND a toast of the round
      // line underneath it: two aria-live regions talking over each other
      // about one tap.)
      if (r?.caughtUp) celebrate(r.showTitle ?? item.title);
      else if (r?.roundComplete) {
        setRoundDone(true);
        // `?? 2` so the round card can never fall back to the caught-up one:
        // roundComplete means a round existed, and 2 is the lowest there is.
        celebrate(r.showTitle ?? item.title, { round: r.round ?? item.rewatch?.round ?? 2 });
      }
    } catch {
      setMarkedId(null); // rejected — unwind the optimistic check
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wn-tile">
      <Link to={to} className="wn-tile-link" draggable={false}>
        <div className={posterArt ? "wn-tile-thumb is-poster" : "wn-tile-thumb"}>
          {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="poster-fallback">{item.title}</div>}
          {count != null && count > 0 && <span className="pill wn-tile-count">{count} left</span>}
          {item.airDate && <span className="pill wn-tile-date">{fmtMonthDay(item.airDate)}</span>}
          {/* ↻ ROUND 2 — the round this tile belongs to (on a History tile,
              the round the play went into), in the free top-left corner, well
              clear of the "N left" count, which mid-round is the round's own
              remainder. The exact badge the Library card wears, down to the
              word: on a phone the badge IS the explanation, and "↻ 2" with no
              word reads as TV Time's "×2 = watched twice" to precisely the
              audience we took from TV Time. Amber (a round is progress) over
              the same slate scrim the other thumb pills use, so it holds up on
              any artwork — and it's inside the link, so its words are part of
              the link's accessible name. No `title`: tooltips never fire on
              touch, and it said less than the badge does. */}
          {rewatch && (
            <span className="pill rewatch-pill">
              <IconRewatch size={12} />
              ROUND {rewatch.round}
            </span>
          )}
        </div>
        <div className={canMark ? "wn-tile-body has-check" : "wn-tile-body"}>
          <span className="wn-tile-show">{item.title}</span>
          {/* A bulk mark is ONE viewing event, so it gets one line that says
              what it was. Naming a single episode out of 78 logged in the same
              second would be picking one at random and calling it the
              history. */}
          {!posterArt && item.episodes != null && item.episodes > 1 ? (
            <span className="wn-tile-ep">{item.episodes} episodes</span>
          ) : (
            !posterArt &&
            item.season != null &&
            item.number != null && (
              <span className="wn-tile-ep">
                {epCode(item.season, item.number)}
                {item.episodeTitle ? ` - ${item.episodeTitle}` : ""}
              </span>
            )
          )}
        </div>
      </Link>
      {canMark && (
        <span className="wn-tile-check">
          {/* The show title in the label keeps repeated buttons apart for
              screen-reader button navigation. Disabled once checked: the
              mark is one-way here — undo lives on the episode/show page.
              Mid-round the label says which round the tap logs into: the
              button looks identical to a first-watch tile's, but it's putting
              a play into round 2 of a show this user has already finished. */}
          <CheckButton
            checked={checked}
            disabled={busy || checked}
            label={
              checked
                ? `Marked ${item.title} watched`
                : (item.season != null && item.number != null
                    ? `Mark ${item.title} ${epCode(item.season, item.number)} watched`
                    : `Mark ${item.title} watched`) + (rewatch ? ` for round ${rewatch.round}` : "")
            }
            onToggle={markWatched}
          />
        </span>
      )}
      {item.username && (
        <span className="wn-tile-ep wn-tile-user">
          <Link to={`/u/${item.username}`} draggable={false}>
            {item.username}
          </Link>
        </span>
      )}
      {item.username && <ReactionButton item={item} />}
    </div>
  );
}

// Click-and-drag horizontal scrolling for the tile rows on desktop, matching
// the native touch-drag that already works on mobile. Once a drag
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
// slider feeds it stat cards — one scroller, so the drag/click
// behavior can never fork between them. `posterArt` rows (Not Started)
// mark the strip `.is-poster` so its portrait tiles take a narrower
// column and drop the deliberate half-tile peek other rows use (see styles).
export function ScrollRow({ children, posterArt }: { children: React.ReactNode; posterArt?: boolean }) {
  const drag = useDragScroll<HTMLDivElement>();
  return (
    <div
      className={posterArt ? "wn-row is-poster" : "wn-row"}
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
export function Row({ items, markable, onWatched, posterArt }: { items: TileItem[]; markable?: boolean; onWatched?: () => void; posterArt?: boolean }) {
  return (
    <ScrollRow posterArt={posterArt}>
      {items.map((it, i) => (
        <Tile key={`${it.kind}-${it.id}-${i}`} item={it} markable={markable} onWatched={onWatched} posterArt={posterArt} />
      ))}
    </ScrollRow>
  );
}

// A ScrollRow of arbitrary children in the Watch Now section chrome:
// the heading bar over the strip. With `to` the heading is itself the
// link — h2 plus a chevron — opening the fuller page behind the row; without
// it the heading is plain text (the profile's Stats slider has
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
// tiles under it.
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
