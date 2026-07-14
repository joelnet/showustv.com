import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "../app";
import { useApi } from "../hooks";
import { Empty, ErrorNote } from "../components/ui";
import { IconEye, IconEyeSlash } from "../components/icons";
import { HomeSkeleton, TileGridSkeleton } from "../components/skeleton";
// The tile, row, and drag-scroll mechanics moved to components/tiles.tsx
// (issue #245) so the profile's history rows render with the exact same look.
import { Tile, Row, type TileItem } from "../components/tiles";
import { precacheContinueWatching } from "../precache";

interface HomeData {
  continueWatching: TileItem[];
  upcoming: TileItem[];
  havenWatched: TileItem[];
  notStarted: TileItem[];
  history: TileItem[];
  friendsWatched: TileItem[];
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

// Sections whose tiles show the show's portrait poster ("show art") rather
// than the episode still (issue #300). Only Not Started: its shows are
// unstarted, so the poster sells them better than a still from an episode the
// user hasn't reached. The queue's other sections track a specific episode
// mid-watch, where the still is the right, more informative image.
const POSTER_ART_SECTIONS: ReadonlySet<SectionKey> = new Set(["notstarted"]);

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
            {!isHidden && (
              <Row items={s.items} markable={MARKABLE_SECTIONS.has(s.key)} posterArt={POSTER_ART_SECTIONS.has(s.key)} onWatched={reload} />
            )}
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
        <TileGridSkeleton posterArt={POSTER_ART_SECTIONS.has(section.key)} />
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
            <Tile
              key={`${it.kind}-${it.id}-${i}`}
              item={it}
              markable={MARKABLE_SECTIONS.has(section.key)}
              posterArt={POSTER_ART_SECTIONS.has(section.key)}
              onWatched={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
