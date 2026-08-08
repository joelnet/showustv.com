import { useState, type ReactElement } from "react";
import { NavLink } from "react-router-dom";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { PosterCard, Progress, Empty, ErrorNote } from "../components/ui";
import { IconRewatch } from "../components/icons";
import { PosterGridSkeleton } from "../components/skeleton";
import { mediaPath } from "../paths";

// The Library's tabs partition every tracked show. "Watching" is
// tracked shows that are not up to date, not finished, and not abandoned —
// i.e. with unwatched aired episodes remaining, whether started or not,
// active or gone quiet. (Watch Next still queues those episodes; the Library
// lists the shows. "Abandoned" is the display label for the stored 'stopped'
// state.) "Watch Later" is the shows half of the
// retired top-level Watchlist tab — saved-for-later shows, fed by the
// payload's separate watchlistShows bucket rather than derived state.
const STATE_SECTIONS: [string, string][] = [
  ["watching", "Watching"],
  ["up_to_date", "Up to date"],
  ["finished", "Finished"],
  ["stopped", "Abandoned"],
  ["watch_later", "Watch Later"],
];

// Derived watching (stale or not) and not-started shows with aired episodes
// fall under the Watching tab — tracked with something left to watch.
// A followed show with nothing aired yet has nothing to be behind on,
// so it counts as up to date. The reference states map 1:1; every show lands
// in exactly one bucket.
function showBucket(s: LibShow): string {
  if (s.derivedState === "watching") return "watching";
  if (s.derivedState === "not_started") return s.aired > 0 ? "watching" : "up_to_date";
  return s.derivedState;
}

// The Library sort: one control, shared by the Shows, Movies,
// and Anime tabs — each with its own persisted choice, so sorting Movies A–Z
// doesn't reorder Shows. The keys are viewer-local UI preferences, which is
// why the public library shares them too: the sort belongs to
// whoever is looking, not to whose library it is.
type LibrarySort = "last_watched" | "alphabetical";
const SHOW_SORT_KEY = "library-show-sort";
const MOVIE_SORT_KEY = "library-movie-sort";
const ANIME_SORT_KEY = "library-anime-sort";

// Last watched: most recent first; never-watched items sink to the bottom.
// Alphabetical is the tiebreak (and the whole order for "alphabetical").
// `watchedAt` maps the item to its timestamp — shows' last_watched_at is
// nullable, movies' watched_at never is (a Seen movie was, by definition).
function libraryComparator<T extends { title: string }>(
  sort: LibrarySort,
  watchedAt: (item: T) => string | null
) {
  return (a: T, b: T): number => {
    const aw = watchedAt(a);
    const bw = watchedAt(b);
    if (sort === "last_watched" && aw !== bw) {
      if (aw == null) return 1;
      if (bw == null) return -1;
      return aw > bw ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  };
}

// A rewatch round that's just been started has no play to date it yet:
// last_watched_at still reads the newest play, which on a show finished years
// ago would bury the fresh round at the bottom of the Watching tab under
// "Last watched" — the opposite of the point. Starting a round IS the
// activity (the server already counts it that way for staleness and for Watch
// Next's ordering), so a round with nothing ticked in it yet sorts as the
// freshest thing in the list; the first tick then dates it for real.
const JUST_STARTED = "\uffff"; // sorts after any ISO-8601 timestamp
const roundAwareWatchedAt = (s: LibShow) =>
  s.rewatch && s.rewatch.roundWatched === 0 ? JUST_STARTED : s.last_watched_at;

const showComparator = (sort: LibrarySort) => libraryComparator<LibShow>(sort, roundAwareWatchedAt);
const movieComparator = (sort: LibrarySort) => libraryComparator<LibMovie>(sort, (m) => m.watched_at);

function useLibrarySort(key: string): [LibrarySort, (value: LibrarySort) => void] {
  const [sort, setSort] = useState<LibrarySort>(() =>
    localStorage.getItem(key) === "alphabetical" ? "alphabetical" : "last_watched"
  );
  function change(value: LibrarySort) {
    setSort(value);
    localStorage.setItem(key, value);
  }
  return [sort, change];
}

function SortBar({ sort, onChange }: { sort: LibrarySort; onChange: (value: LibrarySort) => void }) {
  return (
    <div className="sort-bar">
      <label>
        Sort
        <select value={sort} onChange={(e) => onChange(e.target.value as LibrarySort)}>
          <option value="last_watched">Last watched</option>
          <option value="alphabetical">Alphabetical (A–Z)</option>
        </select>
      </label>
    </div>
  );
}

export interface LibShow {
  id: number;
  title: string;
  poster: string | null;
  derivedState: string;
  stale: boolean;
  watched: number;
  aired: number;
  total: number;
  last_watched_at: string | null;
  // Hidden from the owner's public surfaces. Only the owner's
  // own payload ever carries it — the public library filters hidden shows
  // server-side — so the marker below can never render for a visitor.
  hidden?: boolean;
  // The open rewatch round (0043), owner payload only — the public library
  // never carries the field. `watched` above stays the LIFETIME count either
  // way, exactly as on /shows/:id; the round's own progress is
  // `rewatch.roundWatched`, named the same on every endpoint that reports it
  // (src/shared/rewatch.ts). The card shows both — a show you finished in
  // 2018 reading "0/78" the instant you start round 2 is the "did my history
  // get wiped?" moment this whole feature exists to prevent.
  rewatch?: { round: number; startedAt?: string; roundWatched: number } | null;
  // Completed rounds. Times-through = rounds + 1, so this is what the card's
  // ×2 says — the one thing TV Time refugees liked about TV Time, and the
  // only trace a finished rerun leaves in a grid of posters.
  rounds?: number;
}
export interface LibMovie {
  id: number;
  title: string;
  poster: string | null;
  watched_at: string;
  play_count: number;
}
export interface WatchlistItem {
  id: number;
  title: string;
  poster: string | null;
}

// The progress meta line under a show poster, with a subtle "hidden" marker
// so the owner can spot — and go unhide — shows they've taken
// off their public profile. The show page's eye toggle is where that happens.
//
// Mid-rewatch the loud number is the ROUND's (`rewatch.roundWatched`) and the
// lifetime one (`watched`, the same key and the same meaning as everywhere
// else in the API) rides along right behind it, exactly like the show page's
// dual readout — down to the WORD. It used to say "seen 78/78" here and
// "lifetime 78/78" on the show page: two names, one screen apart, for the one
// number this feature promises never changes, and "seen" reads as a third
// state next to "watched" and "round". Both, always: a card that says only
// "0/78" on a show you finished in 2018 is the app telling you it lost your
// history.
const showSub = (s: LibShow) =>
  `${s.rewatch ? s.rewatch.roundWatched : s.watched}/${s.aired}` +
  (s.rewatch ? ` · lifetime ${s.watched}/${s.aired}` : "") +
  (s.hidden ? " · hidden" : "");

// ↻ ROUND 2 while a round is open; ↻ ×2 once one has finished. Same atom on
// the Library card and the Watch Next tile — same icon, same words, same mono,
// same pill — because it answers the same question in both places ("why is a
// show I finished sitting in my queue?"). Amber only for the open round: a
// round in progress IS progress, the one thing amber is allowed to mean, while
// a times-through count is production metadata and takes the warm white the
// app's other over-art pills use. Decorative in the a11y tree — the link that
// wraps it carries the whole sentence in its own label (see ShowCard).
function RewatchBadge({ round, rounds }: { round?: number; rounds?: number }) {
  if (!round && !rounds) return null;
  return (
    <span className={round ? "pill rewatch-pill" : "pill rewatch-pill is-done"} aria-hidden="true">
      <IconRewatch size={12} />
      {round ? `ROUND ${round}` : `×${rounds! + 1}`}
    </span>
  );
}

// One show card in a progress-bearing tab (Watching / Up to date / Abandoned,
// and the Anime tab's shows): poster, title, watched/aired, progress bar.
//
// Mid-rewatch it also wears the ↻ ROUND 2 badge, stamped on the corner of the
// art. That corner rather than a line of its own for two reasons: the grid's
// progress bars stay on one shared baseline across the row (a chip beside the
// bar pushes that card's bar down and the whole row loses its line), and a
// badge on the art is what actually catches the eye when you're scanning 185
// posters for the show you just put back in rotation. It has to catch the
// eye: mid-round the bar and the loud number are the ROUND's, and without the
// badge they'd read as a lifetime that had run backwards.
// This is the TV Time payoff in the grid — a show you finished years ago,
// sitting in Watching again, with every play it ever had still on the books.
// Shared by both grids so the two can't drift.
//
// Nothing here uses a `title` tooltip: it never fires on touch, which is where
// this product lives, and everything it could have said is now on screen (the
// lifetime count in the sub line) or in the link's accessible name.
function ShowCard({ show }: { show: LibShow }) {
  const round = show.rewatch;
  const rounds = show.rounds ?? 0;
  // The link's own name, because the badge is aria-hidden and "2/73" alone is
  // a lie to anyone who can't see the badge explaining it. Spelled out in
  // words — a screen reader shouldn't have to make sense of "×2".
  // Mid-round the loud number and the bar are the ROUND's; the lifetime count
  // rides in the sub line beside them and in this label.
  const watched = round ? round.roundWatched : show.watched;
  const label = round
    ? `${show.title}, round ${round.round} in progress, ${round.roundWatched} of ${show.aired} episodes this round, ` +
      `${show.watched} of ${show.aired} watched before`
    : rounds > 0
      ? `${show.title}, watched ${rounds + 1} times through, ${show.watched} of ${show.aired} episodes`
      : undefined;
  return (
    <div className="lib-card">
      <PosterCard
        to={mediaPath("show", show.id, show.title)}
        posterPath={show.poster}
        title={show.title}
        sub={showSub(show)}
        badge={<RewatchBadge round={round?.round} rounds={rounds} />}
        label={label}
      />
      {/* Mid-round the bar is the ROUND's. Unlabelled it announces a bare
          "3 percent", which on a show you finished years ago is the most
          alarming thing the app could say; the label and valuetext are the
          same pair the show page's round bar carries. */}
      <Progress
        watched={watched}
        total={show.aired}
        label={round ? `Round ${round.round} progress` : "Watch progress"}
        valueText={
          round
            ? `${watched} of ${show.aired} episodes watched in round ${round.round}`
            : `${watched} of ${show.aired} aired episodes watched`
        }
      />
    </div>
  );
}

// The shows library: a status tab bar (Watching / Up to date / Finished /
// Abandoned / Watch Later — only tabs that have shows appear), and the active
// tab's poster grid. Since the buckets partition the payload, the zero-tabs
// empty state only shows when there are no tracked or saved shows at all.
// Exported for the public library page, which is read-only —
// this component already is: it only navigates and sorts. `empty` swaps the
// owner-directed zero-tabs message for visitor copy there; `watchlist` is
// owner-only — the public payload never carries the bucket, so
// no Watch Later tab can appear there.
export function ShowsLibrary({ shows, watchlist = [], empty }: { shows: LibShow[]; watchlist?: WatchlistItem[]; empty?: ReactElement }) {
  const [sort, setSort] = useLibrarySort(SHOW_SORT_KEY);
  const [tab, setTab] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const s of shows) {
    const b = showBucket(s);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  if (watchlist.length > 0) counts.set("watch_later", watchlist.length);
  const tabs = STATE_SECTIONS.filter(([key]) => counts.has(key));
  // Keep the chosen tab while it still holds shows; otherwise fall to the first.
  const activeKey = tab && counts.has(tab) ? tab : tabs[0]?.[0];
  const activeShows = shows.filter((s) => showBucket(s) === activeKey).sort(showComparator(sort));

  if (tabs.length === 0) {
    return (
      empty ?? (
        <Empty title="No shows yet" hint="Follow a show from search and it shows up here." />
      )
    );
  }

  return (
    <>
      <nav className="subtabs" aria-label="Library category">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={key === activeKey ? "active" : ""}
            aria-current={key === activeKey ? "true" : undefined}
            onClick={() => setTab(key)}
          >
            {label} <span className="count">{counts.get(key)}</span>
          </button>
        ))}
      </nav>
      {activeKey === "watch_later" ? (
        // Saved-for-later shows have no watch activity to sort or track —
        // plain poster cards, newest saves first (server order), no sort bar.
        <div className="poster-grid">
          {watchlist.map((s) => (
            <PosterCard key={s.id} to={mediaPath("show", s.id, s.title)} posterPath={s.poster} title={s.title} />
          ))}
        </div>
      ) : (
        <>
          <SortBar sort={sort} onChange={setSort} />
          <div className="poster-grid">
            {activeShows.map((s) =>
              // Finished shows: every episode is watched, so the
              // watched/aired meta line and the always-full progress bar say
              // nothing — just the poster with an episode-count pill. A show
              // that has been round the block, though, is NOT the same as one
              // watched once, and the Finished tab is exactly where a
              // completed round lands: it wears the ×N badge so the rerun
              // leaves a trace in the grid people actually scan, not only on
              // the show page.
              activeKey === "finished" ? (
                <PosterCard
                  key={s.id}
                  to={mediaPath("show", s.id, s.title)}
                  posterPath={s.poster}
                  title={s.title}
                  pill={`${s.total} ${s.total === 1 ? "episode" : "episodes"}${s.hidden ? " · hidden" : ""}`}
                  badge={<RewatchBadge rounds={s.rounds} />}
                  label={
                    s.rounds
                      ? `${s.title}, ${s.total} ${s.total === 1 ? "episode" : "episodes"}${s.hidden ? ", hidden" : ""}, watched ${s.rounds + 1} times through`
                      : undefined
                  }
                />
              ) : (
                <ShowCard key={s.id} show={s} />
              )
            )}
          </div>
        </>
      )}
    </>
  );
}

// The movies tab's poster grid. `tz` shapes the watched-at sub line — the
// viewer's saved timezone here, the visitor's own on the public library page,
// where AnimeLibrary below is reused as-is. Renders in the
// order given; sorting is the caller's business (AnimeLibrary shares one
// sort across its two sections, so the bar can't live in here).
export function MovieGrid({ movies, tz }: { movies: LibMovie[]; tz: string }) {
  return (
    <div className="poster-grid">
      {movies.map((m) => (
        <PosterCard
          key={m.id}
          to={mediaPath("movie", m.id, m.title)}
          posterPath={m.poster}
          title={m.title}
          sub={fmtDateTime(m.watched_at, tz)}
        />
      ))}
    </div>
  );
}

// MovieGrid under the Shows tab's sort bar: watched movies,
// sortable just like shows. Both movie surfaces render this — the owner
// Library's Seen subtab and the public library's Movies tab — so the one
// persisted key follows the viewer across them.
export function SortedMovieGrid({ movies, tz }: { movies: LibMovie[]; tz: string }) {
  const [sort, setSort] = useLibrarySort(MOVIE_SORT_KEY);
  return (
    <>
      <SortBar sort={sort} onChange={setSort} />
      <MovieGrid movies={[...movies].sort(movieComparator(sort))} tz={tz} />
    </>
  );
}

// The movies library: a subtab bar mirroring ShowsLibrary's.
// Movies have exactly two states (0001_init.sql CHECK: watched / watchlist),
// so Seen and Watch Later fully partition them — Seen is the payload's
// `movies` bucket (anime movies excluded there, they live on the Anime tab),
// Watch Later is `watchlistMovies` (unsplit — one planning list, exactly what
// the retired top-level Watchlist tab held). Owner-only: the public library
// page renders SortedMovieGrid directly, so no Watch Later leaks there.
function MoviesLibrary({ movies, watchlist = [], tz }: { movies: LibMovie[]; watchlist?: WatchlistItem[]; tz: string }) {
  const [tab, setTab] = useState<string | null>(null);

  const sections: [string, string, number][] = [
    ["seen", "Seen", movies.length],
    ["watch_later", "Watch Later", watchlist.length],
  ];
  const tabs = sections.filter(([, , count]) => count > 0);
  // Keep the chosen tab while it still holds movies; otherwise fall to the first.
  const activeKey = tab && tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];

  if (tabs.length === 0) {
    return <Empty title="No movies yet" hint="Mark a movie watched — or save it for later — and it lands here." />;
  }

  return (
    <>
      <nav className="subtabs" aria-label="Library category">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            className={key === activeKey ? "active" : ""}
            aria-current={key === activeKey ? "true" : undefined}
            onClick={() => setTab(key)}
          >
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </nav>
      {activeKey === "seen" ? (
        <SortedMovieGrid movies={movies} tz={tz} />
      ) : (
        // Watch Later: nothing watched yet, so nothing to sort and no
        // watched-at sub line — plain poster cards in the retired Watchlist
        // tab's order (server-side), no sort bar, same as Shows' Watch Later.
        <div className="poster-grid">
          {watchlist.map((m) => (
            <PosterCard key={m.id} to={mediaPath("movie", m.id, m.title)} posterPath={m.poster} title={m.title} />
          ))}
        </div>
      )}
    </>
  );
}

// The anime tab: shows (with progress) and movies as two headed sections.
// Callers guarantee at least one of the two is non-empty. One sort bar
// orders both sections — they're one collection split by medium,
// not two lists that would each earn a control.
export function AnimeLibrary({ shows, movies, tz }: { shows: LibShow[]; movies: LibMovie[]; tz: string }) {
  const [sort, setSort] = useLibrarySort(ANIME_SORT_KEY);
  return (
    <>
      <SortBar sort={sort} onChange={setSort} />
      {shows.length > 0 && (
        <section>
          <h2 className="section-title">Shows</h2>
          <div className="poster-grid">
            {[...shows].sort(showComparator(sort)).map((s) => (
              <ShowCard key={s.id} show={s} />
            ))}
          </div>
        </section>
      )}
      {movies.length > 0 && (
        <section>
          <h2 className="section-title">Movies</h2>
          <MovieGrid movies={[...movies].sort(movieComparator(sort))} tz={tz} />
        </section>
      )}
    </>
  );
}

// The top-level tabs are media categories only: the old
// Watchlist tab — a planning list posing as a peer of Shows/Movies/Anime, and
// the root of the "is Movies things I've watched?" confusion — is folded into
// Watch Later subtabs under Shows and Movies (/library/watchlist redirects
// here in app.tsx).
export function LibraryPage({ tab }: { tab: "shows" | "movies" | "anime" }) {
  const { user } = useAuth();
  const lib = useApi<{
    shows: LibShow[];
    movies: LibMovie[];
    animeShows: LibShow[];
    animeMovies: LibMovie[];
    // Optional: tolerates older service-worker-cached payloads, which lack
    // the Watch Later buckets — they paint before revalidation (hooks.ts).
    watchlistShows?: WatchlistItem[];
    watchlistMovies?: WatchlistItem[];
  }>("/library");

  return (
    <div>
      <h1 className="page-title">Library</h1>
      <nav className="tabs" aria-label="Library sections">
        <NavLink to="/library" end>Shows</NavLink>
        <NavLink to="/library/movies">Movies</NavLink>
        <NavLink to="/library/anime">Anime</NavLink>
      </nav>

      {tab === "shows" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : (
          <ShowsLibrary shows={lib.data!.shows} watchlist={lib.data!.watchlistShows} />
        ))}

      {tab === "movies" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : (
          <MoviesLibrary movies={lib.data!.movies} watchlist={lib.data!.watchlistMovies} tz={user!.tz} />
        ))}

      {tab === "anime" &&
        (lib.loading ? (
          <PosterGridSkeleton />
        ) : lib.error ? (
          <ErrorNote message={lib.error} />
        ) : !lib.data?.animeShows.length && !lib.data?.animeMovies.length ? (
          <Empty title="No anime yet" hint="Follow an anime show or mark an anime movie watched and it lands here." />
        ) : (
          <AnimeLibrary shows={lib.data!.animeShows} movies={lib.data!.animeMovies} tz={user!.tz} />
        ))}
    </div>
  );
}
