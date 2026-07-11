// Skeleton loaders (issue #138): slate placeholder blocks shaped like the
// content they stand in for, so a loading view reads as the page assembling
// instead of a spinner blocking it. Each composed skeleton reuses the real
// layout classes (poster-grid, wn-row, show-hero, ...) so the geometry matches
// and nothing jumps when the data lands.
//
// Accessibility: every skeleton screen announces a single "Loading" via
// role="status" + aria-busy on its wrapper (same contract the Spinner had);
// the blocks themselves are aria-hidden decoration. The pulse animation stops
// under prefers-reduced-motion (see styles.css).

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// Deterministic pseudo-random line widths so a stack of lines reads as text,
// not a rectangle — and never changes between renders.
const w = (i: number, base: number, spread: number) => `${base + ((i * 37) % spread)}%`;

// The base block. Purely decorative; compose it inside a <SkeletonShell>.
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={className ? `skel ${className}` : "skel"} style={style} aria-hidden="true" />;
}

// Wrapper that carries the one accessible loading announcement for a screen
// (or section) of skeleton blocks.
function SkeletonShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={className} role="status" aria-busy="true" aria-label="Loading">
      {children}
    </div>
  );
}

// One 2:3 poster card, matching <PosterCard> (art + title + sub line).
function PosterCardSkeleton({ i }: { i: number }) {
  return (
    <div className="poster-card">
      <Skeleton className="skel-poster" />
      <div className="poster-card-meta">
        <Skeleton className="skel-line" style={{ width: w(i, 55, 35) }} />
        <Skeleton className="skel-line skel-line--sm" style={{ width: w(i + 3, 25, 20) }} />
      </div>
    </div>
  );
}

// Poster grid (library tabs, search results, watchlist, favorites).
export function PosterGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <SkeletonShell className="poster-grid">
      {range(count).map((i) => (
        <PosterCardSkeleton key={i} i={i} />
      ))}
    </SkeletonShell>
  );
}

// Search's logged-out-of-query view: two titled trending sections. The server
// sends 18 per section, so the skeleton matches to keep the second section
// head from shifting when data lands.
export function TrendingSkeleton() {
  return (
    <SkeletonShell>
      {range(2).map((s) => (
        <section key={s}>
          <Skeleton className="skel-section-title" />
          <div className="poster-grid">
            {range(18).map((i) => (
              <PosterCardSkeleton key={i} i={i + s * 5} />
            ))}
          </div>
        </section>
      ))}
    </SkeletonShell>
  );
}

// One Watch Next tile: 16:9 thumbnail + show + episode lines (issue #106).
function TileSkeleton({ i }: { i: number }) {
  return (
    <div className="wn-tile">
      <Skeleton className="skel-thumb" />
      <div className="wn-tile-body">
        <Skeleton className="skel-line" style={{ width: w(i, 50, 40) }} />
        <Skeleton className="skel-line skel-line--sm" style={{ width: w(i + 2, 35, 30) }} />
      </div>
    </div>
  );
}

// Watch Next home: section heads over horizontally-scrolling tile rows.
export function HomeSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <SkeletonShell className="wn-home">
      {range(sections).map((s) => (
        <section key={s} className="wn-section">
          <Skeleton className="skel-row-head" />
          <div className="wn-row">
            {range(6).map((i) => (
              <TileSkeleton key={i} i={i + s * 2} />
            ))}
          </div>
        </section>
      ))}
    </SkeletonShell>
  );
}

// The full-section tile grid behind each home row (/watch/:key).
export function TileGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <SkeletonShell className="wn-grid">
      {range(count).map((i) => (
        <TileSkeleton key={i} i={i} />
      ))}
    </SkeletonShell>
  );
}

// Feed rows (notifications, activity, follow lists): an optional small
// poster, then one or two text lines — same surface-card geometry as
// .notif-list / .activity-feed / .list-items rows.
export function RowListSkeleton({ count = 6, thumb = true }: { count?: number; thumb?: boolean }) {
  return (
    <SkeletonShell className="skel-rows">
      {range(count).map((i) => (
        <SkeletonRow key={i} i={i} thumb={thumb} />
      ))}
    </SkeletonShell>
  );
}

function SkeletonRow({ i, thumb }: { i: number; thumb: boolean }) {
  return (
    <div className="skel-row">
      {thumb && <Skeleton className="skel-row-poster" />}
      <div className="skel-row-text">
        <Skeleton className="skel-line" style={{ width: w(i, 40, 45) }} />
        <Skeleton className="skel-line skel-line--sm" style={{ width: w(i + 3, 18, 22) }} />
      </div>
    </div>
  );
}

// Lists index: collage cards in the lists grid.
export function ListsGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonShell className="lists-grid">
      {range(count).map((i) => (
        <div key={i} className="list-card">
          <Skeleton className="skel-collage" />
          <Skeleton className="skel-line" style={{ width: w(i, 45, 30) }} />
          <Skeleton className="skel-line skel-line--sm" style={{ width: "40%" }} />
        </div>
      ))}
    </SkeletonShell>
  );
}

// List detail: title + action buttons, then item rows with the small 42px
// poster the real rows use. The page renders its static crumb itself.
export function ListDetailSkeleton() {
  return (
    <SkeletonShell>
      <div className="list-head">
        <Skeleton className="skel-page-title" />
        <div className="list-head-actions">
          <Skeleton className="skel-btn" />
          <Skeleton className="skel-btn" />
        </div>
      </div>
      <div className="skel-rows">
        {range(5).map((i) => (
          <div key={i} className="skel-row">
            <Skeleton className="skel-line skel-line--sm" style={{ width: 22, flexShrink: 0 }} />
            <Skeleton className="skel-list-poster" />
            <div className="skel-row-text">
              <Skeleton className="skel-line" style={{ width: w(i, 35, 40) }} />
              <Skeleton className="skel-line skel-line--sm" style={{ width: w(i + 1, 12, 15) }} />
            </div>
            <div className="list-item-actions">
              <Skeleton className="skel-row-btn" />
              <Skeleton className="skel-row-btn" />
              <Skeleton className="skel-row-btn" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonShell>
  );
}

// Public list: the detailed poster + overview recommendation cards.
export function PubListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonShell>
      <Skeleton className="skel-page-title" />
      <Skeleton className="skel-line skel-line--sm" style={{ width: 230, maxWidth: "70%", marginBottom: 20 }} />
      <div className="pub-list">
        {range(count).map((i) => (
          <div key={i} className="pub-list-item">
            <Skeleton className="skel-pub-poster" />
            <div className="pub-list-body" style={{ flex: 1 }}>
              <Skeleton className="skel-line skel-line--lg" style={{ width: w(i, 30, 35) }} />
              <Skeleton className="skel-line skel-line--sm" style={{ width: 40 }} />
              <Skeleton className="skel-line" style={{ width: "92%" }} />
              <Skeleton className="skel-line" style={{ width: w(i + 2, 45, 40) }} />
            </div>
          </div>
        ))}
      </div>
    </SkeletonShell>
  );
}

// Profile (own and public): username title (plus the bare share/pencil icons,
// privacy toggle, and its status text on your own, issues #162/#182/#241),
// the three stat cards, then a section of rows.
export function ProfileSkeleton({ action = false }: { action?: boolean }) {
  return (
    <SkeletonShell>
      <div className="profile-head">
        <Skeleton className="skel-page-title" />
        {action && (
          <>
            <Skeleton className="skel-btn skel-btn--icon" />
            <Skeleton className="skel-btn skel-btn--icon" />
            <div className="profile-privacy">
              <Skeleton className="skel-btn skel-btn--icon" />
              <Skeleton className="skel-line skel-line--sm" style={{ width: 130 }} />
            </div>
          </>
        )}
      </div>
      <div className="profile-stats">
        {range(3).map((i) => (
          <Skeleton key={i} className="skel-stat" />
        ))}
      </div>
      <Skeleton className="skel-section-title" />
      <div className="skel-rows">
        {range(3).map((i) => (
          <SkeletonRow key={i} i={i} thumb={false} />
        ))}
      </div>
    </SkeletonShell>
  );
}

// Following: the follow-by-username form, then two follow sections and the
// start of the activity feed.
export function FollowingSkeleton() {
  return (
    <SkeletonShell>
      <div className="friend-add">
        <Skeleton className="skel-input" />
        <Skeleton className="skel-btn" />
      </div>
      {range(2).map((s) => (
        <section key={s}>
          <Skeleton className="skel-section-title" />
          <div className="skel-rows">
            {range(3).map((i) => (
              <SkeletonRow key={i} i={i + s} thumb={false} />
            ))}
          </div>
        </section>
      ))}
    </SkeletonShell>
  );
}

// Show page: hero panel (poster, title, action row, progress), overview
// copy, then a few collapsed season bars.
export function ShowPageSkeleton() {
  return (
    <SkeletonShell className="show-page">
      <section className="show-hero">
        <div className="show-hero-inner">
          <Skeleton className="show-poster" />
          <div className="show-hero-text">
            <Skeleton className="skel-line skel-line--h1" style={{ width: 320, maxWidth: "75%" }} />
            <Skeleton className="skel-line skel-line--sm" style={{ width: 230, maxWidth: "60%" }} />
            <div className="show-actions">
              <Skeleton className="skel-btn" />
              <Skeleton className="skel-btn" />
              <Skeleton className="skel-btn skel-btn--round" />
            </div>
            <Skeleton className="skel-line skel-line--sm" style={{ width: 260, maxWidth: "65%" }} />
          </div>
        </div>
      </section>
      <div className="skel-copy">
        <Skeleton className="skel-line" style={{ width: "96%" }} />
        <Skeleton className="skel-line" style={{ width: "88%" }} />
        <Skeleton className="skel-line" style={{ width: "55%" }} />
      </div>
      <div className="seasons">
        {range(3).map((i) => (
          <Skeleton key={i} className="skel-season" />
        ))}
      </div>
    </SkeletonShell>
  );
}

// Movie and episode pages share the poster/still + text-column head layout.
export function MediaDetailSkeleton({ kind }: { kind: "movie" | "episode" }) {
  return (
    <SkeletonShell className={kind === "movie" ? "movie-page" : "episode-page"}>
      {kind === "episode" && <Skeleton className="skel-line skel-show-link" style={{ width: 220, maxWidth: "70%" }} />}
      <div className={kind === "movie" ? "movie-head" : "episode-head"}>
        {kind === "movie" ? <Skeleton className="show-poster" /> : <Skeleton className="episode-still skel-still" />}
        <div className="skel-detail-body">
          <Skeleton className="skel-line skel-line--h1" style={{ width: 300, maxWidth: "80%" }} />
          <Skeleton className="skel-line skel-line--sm" style={{ width: 220, maxWidth: "60%" }} />
          <div className="skel-copy">
            <Skeleton className="skel-line" style={{ width: "92%" }} />
            <Skeleton className="skel-line" style={{ width: "85%" }} />
            <Skeleton className="skel-line" style={{ width: "50%" }} />
          </div>
          <div className={kind === "movie" ? "show-actions" : "episode-actions"}>
            <Skeleton className="skel-btn" />
            <Skeleton className="skel-btn" />
          </div>
        </div>
      </div>
    </SkeletonShell>
  );
}

// Comment threads: a byline and a couple of body lines per comment.
export function CommentsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonShell className="comment-list">
      {range(count).map((i) => (
        <div key={i} className="comment">
          <div className="comment-main">
            <Skeleton className="skel-line skel-line--sm" style={{ width: 150, maxWidth: "50%" }} />
            <Skeleton className="skel-line" style={{ width: w(i, 55, 40) }} />
            <Skeleton className="skel-line" style={{ width: w(i + 1, 25, 35) }} />
          </div>
        </div>
      ))}
    </SkeletonShell>
  );
}
