import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, post, put, del, ApiError } from "../api";
import { mediaPath, idFromParam } from "../paths";
import { useApi, useDocumentTitle, getCached, setCached, dropCached, readApiCache } from "../hooks";
import { useAuth } from "../app";
import { poster, backdrop } from "../img";
import { fmtAirDate, fmtEpisodeDate, epCode } from "../format";
import { Slate, ErrorNote, Progress, CheckButton, StarRating, ExternalLinks } from "../components/ui";
import { ShowPageSkeleton } from "../components/skeleton";
import { WhereToWatch, type WatchInfo } from "../components/where-to-watch";
import { Comments } from "../components/comments";
import { useCelebrate } from "../components/celebration";
import { IconCheck, IconPlus, IconChevron, IconBookmark, IconHeart, IconHeartOutline, IconHatGlasses, IconTrash, IconRewatch } from "../components/icons";
import { useConfirm } from "../components/dialog";
import { useToast } from "../components/toast";
import { ShareButton } from "../components/share";
import { AddToList } from "./lists";

interface Episode {
  id: number;
  season_number: number;
  number: number;
  title: string | null;
  air_date: string | null;
  aired: boolean;
  // Viewer state — absent on the anonymous payload.
  watched?: boolean;
  playCount?: number;
  // Rewatch: whether this episode has a play stamped since the active round
  // started. The server ships it ONLY while a round is open, so its presence
  // is not the signal the UI keys off — `user.rewatch` is (a stale
  // service-worker payload could carry either one alone).
  watchedThisRound?: boolean;
}

interface ShowPayload {
  show: {
    id: number;
    title: string;
    status: string;
    firstAirDate: string | null;
    poster: string | null;
    backdrop: string | null;
    overview: string | null;
    genres: string[];
    imdbId: string | null;
  };
  seasons: { id: number; number: number; name: string | null; episodes: Episode[] }[];
  // `user` and `progress` are null on the anonymous payload —
  // the server never ships user-shaped fields without a session.
  user: {
    followed: boolean;
    state: string | null;
    rating: { score: number | null } | null;
    favorited: boolean;
    // Hidden from the viewer's public surfaces. Optional so a
    // stale service-worker-cached payload still renders.
    hidden?: boolean;
    // The open rewatch round, or null outside one. Round progress is
    // `roundWatched` — aired regular-season episodes with a play since
    // `startedAt` — and it is called that on every endpoint that reports it
    // (src/shared/rewatch.ts); `progress.watched` below is the LIFETIME count
    // on every endpoint. The two never trade names. Optional for the same
    // stale-payload reason as `hidden`.
    rewatch?: { round: number; startedAt: string; roundWatched: number } | null;
    // Rewatch rounds already finished; 0 for almost every show. Round 2 is
    // the first rewatch, so times-through = rounds + 1.
    rounds?: number;
    // The most recent finished round, so a completed rerun leaves a DATED
    // trace on the page instead of silently bumping a counter (Simkl lists
    // every session with its dates; ours at least states the last one).
    // Optional/null for the same stale-payload reason as `hidden`.
    lastRound?: { round: number; finishedAt: string } | null;
  } | null;
  progress: { watched: number; aired: number; total: number } | null;
  nextEpisode: Episode | null;
  watch: WatchInfo;
}

// ---- Rewatch ----
// A round is one explicit rerun of a show (round 2 = the first rewatch; the
// original watch is implicitly round 1). While one is open the page speaks
// the round — checkmarks, season counts, the progress bar — on top of the
// lifetime numbers, which a rewatch never disturbs. That layering is the
// whole feature: TV Time could only put a finished show back in the queue by
// destructively unwatching it.
type Round = NonNullable<NonNullable<ShowPayload["user"]>["rewatch"]>;

// The bits of a mutation reply this page reads. Every watch route can answer
// `roundComplete` (the mark that closed the round); POST /rewatch answers the
// round it opened. Everything else replies `{ ok: true }` and lands here as
// an empty object.
interface MutationResult {
  roundComplete?: boolean;
  round?: number;
  startedAt?: string;
}

const roundOf = (d: ShowPayload): Round | null => d.user?.rewatch ?? null;

// What to put in a failure toast. The API's own error text is written for
// humans ("You're offline", "a rewatch is already running") so it wins; a bare
// status line from a 5xx isn't, so it rides along with the action's own
// wording instead of replacing it.
function errText(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : "";
  if (!m) return fallback;
  return /^HTTP \d+$/.test(m) ? `${fallback} (${m})` : m;
}

// "Aug 7" — a round's own date, in the viewer's timezone (the stamps are UTC
// ISO like every other timestamp here). The year only appears when it isn't
// the current one, matching fmtAirDate's rule, so the common case stays two
// words inside an already-busy progress row.
function shortDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const year = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  const sameYear = year(d) === year(new Date());
  return d.toLocaleDateString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

// What an episode's tick means right now: mid-round it's THIS round's play,
// outside a round the lifetime watched flag. One definition drives the
// checkboxes, the season counts, the catch-up sweep and pickOpenSeason, so
// they can never disagree about what "watched" means on screen.
const isTicked = (e: Episode, round: Round | null) => (round ? !!e.watchedThisRound : !!e.watched);

// Every per-episode round flag is meaningless across a round boundary (start,
// finish, or stop), so both sides of one wipe them rather than leave the old
// round's ticks to bleed into the next.
function clearRoundFlags(d: ShowPayload): ShowPayload {
  return {
    ...d,
    seasons: d.seasons.map((s) => ({ ...s, episodes: s.episodes.map((e) => ({ ...e, watchedThisRound: false })) })),
  };
}

// Apply a watched-state change locally; progress counts only aired regular
// (season > 0) episodes, matching the server's definition. Only reachable
// signed-in (anonymous viewers have no watch controls), so the null guards
// on user/progress are for the types, not a real code path.
//
// Mid-round the same call moves two counters, mirroring the server: the round
// tick (user.rewatch.roundWatched) always, and lifetime progress only when a mark
// creates an episode's first play ever or an un-tick removes its last one.
// Un-ticking during a round is deliberately NOT an unwatch — it drops this
// round's play, steps play_count back, and the row (the first-watch record)
// survives.
function applyWatch(d: ShowPayload, pred: (e: Episode) => boolean, watched: boolean): ShowPayload {
  const round = roundOf(d);
  let lifetime = 0; // aired regular-season episodes gaining/losing the watched flag
  let inRound = 0; // ...gaining/losing a this-round play
  const counts = (e: Episode) => e.season_number > 0 && e.aired;
  const seasons = d.seasons.map((s) => ({
    ...s,
    episodes: s.episodes.map((e) => {
      if (!pred(e) || (watched && !e.aired)) return e;
      if (!round) {
        if (e.watched === watched) return e;
        if (counts(e)) lifetime += watched ? 1 : -1;
        return { ...e, watched, playCount: watched ? 1 : 0 };
      }
      if (!!e.watchedThisRound === watched) return e;
      if (counts(e)) inRound += watched ? 1 : -1;
      if (watched) {
        // An episode already on the books gains a play; one seen for the
        // first time during the round starts its history at 1.
        if (!e.watched && counts(e)) lifetime += 1;
        return { ...e, watchedThisRound: true, watched: true, playCount: e.watched ? (e.playCount ?? 1) + 1 : 1 };
      }
      // Nothing is lost unless this round's play was the only one there was.
      const keepsRow = (e.playCount ?? 1) > 1;
      if (!keepsRow && counts(e)) lifetime -= 1;
      return keepsRow
        ? { ...e, watchedThisRound: false, playCount: (e.playCount ?? 1) - 1 }
        : { ...e, watchedThisRound: false, watched: false, playCount: 0 };
    }),
  }));
  return {
    ...d,
    seasons,
    progress: d.progress && { ...d.progress, watched: d.progress.watched + lifetime },
    user: d.user && round ? { ...d.user, rewatch: { ...round, roundWatched: round.roundWatched + inRound } } : d.user,
  };
}

// The server just opened a round: it also flips the show to 'watching', which
// is what drops it back into Library Watching and Watch Next — the payoff
// TV Time refugees came for.
function startedRound(d: ShowPayload, round: Round): ShowPayload {
  const base = clearRoundFlags(d);
  return { ...base, user: base.user && { ...base.user, followed: true, state: "watching", rewatch: round } };
}

// Round over — finished by the server's auto-complete, or stopped by the
// viewer. Either way plays are untouched; only a finished round adds to the
// times-through count (a stopped one is deleted outright, as on the server).
function endedRound(d: ShowPayload, finished: boolean): ShowPayload {
  const base = clearRoundFlags(d);
  const ending = base.user?.rewatch;
  if (!base.user || !ending) return d;
  return {
    ...base,
    user: {
      ...base.user,
      rewatch: null,
      rounds: (base.user.rounds ?? 0) + (finished ? 1 : 0),
      // A finished round becomes the dated trace the "watched ×N" line
      // states; a stopped one is deleted server-side, so it leaves none.
      lastRound: finished ? { round: ending.round, finishedAt: new Date().toISOString() } : (base.user.lastRound ?? null),
    },
  };
}

function withUser(d: ShowPayload, user: Partial<NonNullable<ShowPayload["user"]>>): ShowPayload {
  return { ...d, user: d.user && { ...d.user, ...user } };
}

// Full removal: drop the show from the account and reset every
// bit of local state it contributed — history, progress, rating, favorite.
function cleared(d: ShowPayload): ShowPayload {
  return {
    ...d,
    // Rewatch rounds and dated plays go with it — the server drops both.
    user: {
      followed: false,
      state: null,
      rating: null,
      favorited: false,
      hidden: false,
      rewatch: null,
      rounds: 0,
      lastRound: null,
    },
    progress: d.progress && { ...d.progress, watched: 0 },
    seasons: d.seasons.map((s) => ({
      ...s,
      episodes: s.episodes.map((e) => ({ ...e, watched: false, playCount: 0, watchedThisRound: false })),
    })),
  };
}

// Fully caught up: every aired regular-season episode is watched. Uses the
// same aired-only progress counts the server sends, so it matches the app's
// definition of "no episodes left to watch right now".
const isCaughtUp = (d: ShowPayload) =>
  d.progress != null && d.progress.aired > 0 && d.progress.watched >= d.progress.aired;

const isBefore = (e: Episode, target: Episode) =>
  e.season_number < target.season_number ||
  (e.season_number === target.season_number && e.number < target.number);

// Aired, unwatched, regular-season episodes earlier than the target — where
// "unwatched" is round-scoped mid-rewatch, so the catch-up sweep offers to
// fill in the round's gaps rather than reporting none.
function priorUnwatched(d: ShowPayload, target: Episode): number {
  const round = roundOf(d);
  return d.seasons
    .flatMap((s) => s.episodes)
    .filter((e) => e.season_number > 0 && e.aired && !isTicked(e, round) && isBefore(e, target)).length;
}

// The season to open on load: the one the viewer is working through — the
// first regular season with an aired unwatched episode. Fully-watched seasons
// never open, and a caught-up viewer (isCaughtUp — the same aired
// regular-episode counts behind Finished/Up to date) gets every season
// collapsed instead of a force-opened one. An abandoned show
// (state 'stopped') collapses every season too — the viewer has
// stopped and won't be marking new episodes watched, even if aired unwatched
// ones remain — so that check comes first, before the working-season lookup.
// Only a show with nothing aired yet (and specials-only shows never counted)
// keeps the old first-regular-season fallback so upcoming air dates stay
// visible. Shared so a cache seed and a fresh fetch derive it the same way.
function pickOpenSeason(d: ShowPayload): number | null {
  // Mid-rewatch the working season is the ROUND's, not the lifetime one: a
  // caught-up show would otherwise collapse every season the moment the
  // viewer asked to watch it again. Right after starting that lands on S1.
  const round = roundOf(d);
  if (round) {
    const inRound = d.seasons.find((s) => s.number > 0 && s.episodes.some((e) => e.aired && !e.watchedThisRound));
    return inRound?.number ?? null;
  }
  // Nothing left to mark watched — collapse every season.
  if (d.user?.state === "stopped" || isCaughtUp(d)) return null;
  const current = d.seasons.find((s) => s.number > 0 && s.episodes.some((e) => e.aired && !e.watched));
  if (current) return current.number;
  return d.seasons.find((s) => s.number > 0)?.number ?? null;
}

// Episode display order. Ascending is the server's order (season
// 1 first, E1 first). Descending mirrors both levels — latest season first,
// latest episode first within each season — so the most recent episode is the
// first row on the page; specials (season 0) fall to the bottom. One global
// preference per user, never per-show or per-season, stored under a per-user
// key like the Watch Now section layout so two accounts on the
// same browser keep separate choices. Signed-out viewers can flip the order
// for the visit, but nothing is persisted without an account.
type EpisodeSort = "asc" | "desc";

const episodeSortKey = (userId: number) => `show-episode-sort:${userId}`;

function loadEpisodeSort(userId: number | undefined): EpisodeSort {
  if (userId == null) return "asc";
  try {
    return localStorage.getItem(episodeSortKey(userId)) === "desc" ? "desc" : "asc";
  } catch {
    return "asc"; // storage disabled — the default order still renders
  }
}

function saveEpisodeSort(userId: number | undefined, sort: EpisodeSort): void {
  if (userId == null) return;
  try {
    localStorage.setItem(episodeSortKey(userId), sort);
  } catch {
    // storage disabled/full — the choice still applies for this visit
  }
}

// Non-destructive display copy: the payload's seasons stay in server
// (ascending) order because the progress logic (pickOpenSeason,
// priorUnwatched, applyWatch) and the cached copy read them.
function orderSeasons(seasons: ShowPayload["seasons"], sort: EpisodeSort): ShowPayload["seasons"] {
  if (sort === "asc") return seasons;
  return seasons.map((s) => ({ ...s, episodes: [...s.episodes].reverse() })).reverse();
}

// The order dropdown above the seasons list — the Library's sort-bar control,
// same styling and label placement.
function EpisodeSortBar({ sort, onChange }: { sort: EpisodeSort; onChange: (s: EpisodeSort) => void }) {
  return (
    <div className="sort-bar">
      <label>
        Episode order
        <select value={sort} onChange={(e) => onChange(e.target.value as EpisodeSort)}>
          <option value="asc">Ascending (oldest first)</option>
          <option value="desc">Descending (newest first)</option>
        </select>
      </label>
    </div>
  );
}

// People you follow who track this show — username chips linking to their
// profile. Quietly renders nothing while loading, with none, or offline.
function AlsoWatching({ showId }: { showId: string }) {
  const { data } = useApi<{ following: { username: string; state: string }[] }>(`/social/also-watching/${showId}`);
  if (!data?.following.length) return null;
  const label = (state: string) =>
    state === "watch_later"
      ? "wants to watch"
      : state === "finished" || state === "up_to_date"
        ? "watched"
        : state === "stopped"
          ? "abandoned"
          : "watching";
  return (
    <div className="also-watching">
      <span className="also-watching-label">People you follow also watching</span>
      {data.following.map((f) => (
        <Link key={f.username} to={`/u/${f.username}`} className="friend-chip" title={`${f.username}: ${label(f.state)}`}>
          {f.username}
        </Link>
      ))}
    </div>
  );
}

// Signed-out view of a show: the public catalog content — hero,
// overview, where-to-watch, seasons and air dates — plus the read-only
// comment thread. No tracking controls, watch state, progress, or rating: the
// server omits those fields from anonymous payloads. Seasons start collapsed
// (openSeason is null for anonymous viewers; they expand what they want).
function PublicShowView({
  data,
  openSeason,
  setOpenSeason,
  episodeSort,
  onEpisodeSort,
}: {
  data: ShowPayload;
  openSeason: number | null;
  setOpenSeason: (n: number | null) => void;
  episodeSort: EpisodeSort;
  onEpisodeSort: (s: EpisodeSort) => void;
}) {
  const { show, seasons, nextEpisode, watch } = data;
  // No profile timezone without a session — the browser's own is the best
  // stand-in for air-date rendering.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const visibleSeasons = orderSeasons(
    seasons.filter((s) => s.episodes.length > 0),
    episodeSort
  );
  return (
    <div className="show-page">
      <section
        className="show-hero"
        style={show.backdrop ? { backgroundImage: `url(${backdrop(show.backdrop)})` } : undefined}
      >
        <div className="show-hero-scrim">
          <div className="show-hero-inner">
            {show.poster && <img className="show-poster" src={poster(show.poster)!} alt="" />}
            <div className="show-hero-text">
              <h1>{show.title}</h1>
              <p className="show-facts">
                {[show.firstAirDate?.slice(0, 4), show.status, show.genres.join(", ")].filter(Boolean).join(" · ")}
              </p>
              {nextEpisode && (
                <p className="next-chip">
                  <span className="on-air-dot" aria-hidden="true" />
                  Next: <Slate season={nextEpisode.season_number} number={nextEpisode.number} />{" "}
                  {fmtAirDate(nextEpisode.air_date, tz)}
                </p>
              )}
              <div className="show-actions">
                <ShareButton
                  title={show.title}
                  text={`Check out ${show.title} on Show Us TV.`}
                  path={mediaPath("show", show.id, show.title)}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {show.overview && <p className="show-overview">{show.overview}</p>}

      <WhereToWatch watch={watch} title={show.title} />

      <ExternalLinks title={show.title} imdbId={show.imdbId} />

      {visibleSeasons.length > 0 && <EpisodeSortBar sort={episodeSort} onChange={onEpisodeSort} />}

      <section className="seasons">
        {visibleSeasons.map((season) => {
          const open = openSeason === season.number;
          return (
            <div key={season.id} className="season">
              <div className="season-head">
                <button
                  type="button"
                  className="season-toggle"
                  aria-expanded={open}
                  onClick={() => setOpenSeason(open ? null : season.number)}
                >
                  <IconChevron size={14} />
                  <span className="season-name">{season.name ?? `Season ${season.number}`}</span>
                  <span className="mono season-count">
                    {season.episodes.length} {season.episodes.length === 1 ? "episode" : "episodes"}
                  </span>
                </button>
              </div>
              {open && (
                <ul className="episode-list">
                  {season.episodes.map((e) => (
                    <li key={e.id} className={`episode-row${e.aired ? "" : " is-future"}`}>
                      <Slate season={e.season_number} number={e.number} />
                      <Link to={mediaPath("episode", e.id, e.title)} className="episode-title">
                        {e.title ?? `Episode ${e.number}`}
                      </Link>
                      <span className="episode-date mono">{fmtEpisodeDate(e.air_date, e.aired, tz)}</span>
                      {!e.aired && <span className="on-air-dot on-air-dot--future" title="Not aired yet" />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <Comments targetType="show" targetId={show.id} />
    </div>
  );
}

export function ShowPage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const celebrate = useCelebrate();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const cacheKey = `/shows/${id}`;
  // Seed instantly from the Continue Watching precache when present:
  // a tile that was warmed for offline paints its detail
  // page from cache with no loading skeleton; the fetch below then refreshes
  // it in the background. A cold (unseeded) show still shows the skeleton.
  const seed = getCached<ShowPayload>(cacheKey);
  const [data, setData] = useState<ShowPayload | null>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the rewatch start gets its own pending flag: it's the one action
  // whose result (the round chip) appears somewhere other than the control
  // that triggered it, so the button has to say it's working.
  const [starting, setStarting] = useState(false);
  // Signed-out viewers start with every season collapsed; only a
  // signed-in visit auto-opens the season they're working through.
  const [openSeason, setOpenSeason] = useState<number | null>(seed && user ? pickOpenSeason(seed) : null);
  // Global episode order: restored once per mount from the
  // per-user key and kept across show-to-show navigation — it's one setting
  // for the whole account, so no per-show reset.
  const [episodeSort, setEpisodeSort] = useState<EpisodeSort>(() => loadEpisodeSort(user?.id));
  const changeEpisodeSort = (s: EpisodeSort) => {
    setEpisodeSort(s);
    saveEpisodeSort(user?.id, s);
  };

  // Re-read the order preference if the signed-in identity changes while the
  // page stays mounted, so one account's in-memory choice can't bleed into
  // another's session (the same cross-account hygiene used elsewhere).
  useEffect(() => {
    setEpisodeSort(loadEpisodeSort(user?.id));
  }, [user?.id]);
  // Once the user makes a (persisted) optimistic change, a background refetch
  // that started before it holds pre-change state — skip applying it so it
  // can't visually revert the change. The seed makes the page interactive
  // before the mount refetch lands, which is the only way they race.
  const dirty = useRef(false);

  // Canonicalize the address bar to the slugged URL so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("show", data.show.id, data.show.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  // Tab title — matches the <title> the Worker bakes into a
  // hard load of this page.
  useDocumentTitle(data?.show.title);

  useEffect(() => {
    let live = true;
    let settled = false; // the network answered — the SW-cache read is moot
    let painted = false; // the SW-cache copy is on screen (counts like a seed below)
    dirty.current = false; // new show — let its refetch apply
    const cached = getCached<ShowPayload>(cacheKey);
    setData(cached ?? null); // instant warm paint, or the skeleton on a cold load
    setError(null);
    // Whether a payload actually renders the seasons UI for this viewer — a
    // signed-in visit needs the user-shaped fields; without them the page
    // shows a skeleton, so no season toggle could have happened yet.
    const renders = (p: ShowPayload) => !user || (p.user != null && p.progress != null);
    // The open-season pick is settled once it came from a payload the viewer
    // could see (and may have toggled since). A skeleton-only paint — an
    // anonymous SW-cached copy replayed for a signed-in viewer — must not pin
    // a stale default open: the fresh fetch re-picks it below.
    let pickSettled = cached !== undefined && renders(cached);
    if (cached) setOpenSeason(user ? pickOpenSeason(cached) : null);
    if (cached === undefined) {
      // Cold load: paint the service worker's offline copy instantly
      // while the fetch below revalidates — a precached library show
      // skips the skeleton even online. Not written to the page cache: the
      // refetch below stores the fresher copy.
      void readApiCache<ShowPayload>(cacheKey).then((hit) => {
        if (!live || settled || dirty.current || hit === undefined) return;
        painted = true;
        setData(hit);
        setOpenSeason(user ? pickOpenSeason(hit) : null);
        if (renders(hit)) pickSettled = true;
      });
    }
    api<ShowPayload>(cacheKey)
      .then((d) => {
        settled = true;
        // Skip if unmounted/superseded, or if the user already made a change
        // this stale response predates (keep the optimistic view).
        if (!live || dirty.current) return;
        setCached(cacheKey, d); // refresh the shared cache for the next visit
        setData(d);
        // Only pick the open season when nothing the viewer could interact
        // with settled it — a cold load, or a warm paint that only reached
        // the skeleton (any season the user has since toggled stays put).
        // Anonymous viewers keep everything collapsed.
        if (!pickSettled) setOpenSeason(user ? pickOpenSeason(d) : null);
      })
      .catch((e) => {
        settled = true;
        if (!live) return;
        // A definitive 4xx (deleted / private show) means the seed is no longer
        // valid: drop it and surface the error, exactly as useApi does — don't
        // keep serving a page the server now refuses. A transient failure
        // (offline / 5xx) keeps a good seed (or SW-cache paint) on screen (the
        // offline banner explains why) and only errors on a cold load with
        // nothing to show.
        const definitive = e instanceof ApiError && e.status >= 400 && e.status < 500;
        if (definitive) {
          dropCached(cacheKey);
          setData(null);
          setError(e.message);
        } else if (cached === undefined && !painted) {
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <ShowPageSkeleton />;

  // Signed-out visitors (shared links): the public catalog view
  // with a sign-in CTA in place of the tracking controls. The server omits
  // all user state from anonymous payloads, so nothing personal can render
  // here even by accident.
  if (!user)
    return (
      <PublicShowView
        data={data}
        openSeason={openSeason}
        setOpenSeason={setOpenSeason}
        episodeSort={episodeSort}
        onEpisodeSort={changeEpisodeSort}
      />
    );

  // Signed-in requests always carry the viewer's state and progress, but the
  // service worker can replay a payload cached before sign-in (anonymous, no
  // user fields) when the network is gone — treat that as still loading
  // rather than render tracking controls with no state behind them.
  if (!data.user || !data.progress) return <ShowPageSkeleton />;

  const { show, seasons, nextEpisode, watch } = data;
  const mine = data.user;
  const progress = data.progress;
  const tz = user.tz;
  // The open rewatch round (null outside one) and the finished-round count
  // behind the "watched ×N" line. Read once here so every branch below —
  // hero, progress row, season heads, episode rows — speaks the same round.
  const round = roundOf(data);
  const rounds = mine.rounds ?? 0;
  // Display-order copy only — every progress/catch-up computation above stays
  // on the ascending source payload.
  const visibleSeasons = orderSeasons(
    seasons.filter((s) => s.episodes.length > 0),
    episodeSort
  );

  // Whether the show has any trace in the account. Unfollowing keeps watch
  // history and ratings, so "followed" alone would hide Remove for exactly the
  // accidental-add cleanup it exists for — also offer it when history remains.
  const inLibrary =
    mine.followed || mine.favorited || mine.rating != null || seasons.some((s) => s.episodes.some((e) => e.watched));

  // One API call per action; the UI updates from what we already know.
  // `apply` is pure, so any watch action that flips the show from "behind" to
  // "caught up" is caught here in one place — single episode, whole season,
  // mark-all, or a catch-up sweep. Detection runs off the captured
  // `data` (single-flight thanks to `busy`), keeping the side effect out of the
  // state updater so a double-invoked render can't replay the confetti.
  //
  // `apply` also sees the server's reply, because two of this page's
  // mutations answer with state the UI can't guess: the round number POST
  // /rewatch just minted, and `roundComplete` — which ANY watch route can
  // return, so retiring the finished round lives here rather than at five
  // call sites. `after` runs once on the applied payload, for the one thing
  // that isn't payload state (the open-season pick at a round boundary).
  //
  // Every mutation on this page reports its own failure, right here: the
  // optimistic update happens only after the request resolves, so a rejection
  // leaves the screen untouched and the toast is the ONLY thing telling the
  // user their tap did nothing. (One-tap marking is the hot path — it can't
  // be the one action that fails silently.) Resolves true on success, false
  // on failure, so callers can hold their own follow-up toast until the
  // request actually landed.
  const run = (
    fn: () => Promise<MutationResult>,
    apply: (d: ShowPayload, res: MutationResult) => ShowPayload,
    after?: (next: ShowPayload) => void,
    failure = "Couldn’t save that"
  ) => async (): Promise<boolean> => {
    setBusy(true);
    // The user is acting on the data on screen: a mount-time refetch still in
    // flight holds pre-change state, so guard it out now (before it can land)
    // and keep the captured `data` as the single base for both the on-screen
    // and the cached copy. This page never refetched after a mutation anyway.
    dirty.current = true;
    try {
      const res = (await fn()) ?? {};
      const finished = res.roundComplete === true;
      const step = (d: ShowPayload) => (finished ? endedRound(apply(d, res), true) : apply(d, res));
      setData((d) => (d ? step(d) : d));
      if (data) {
        const next = step(data);
        // Keep the shared cache in step so a revisit paints the change, not
        // the pre-change seed.
        setCached(cacheKey, next);
        after?.(next);
        if (finished) {
          // The round just auto-completed: the same confetti as catching up —
          // finishing a rerun is the same kind of win — but the card speaks
          // the ROUND. Sending it the round number is the whole difference
          // between "you're all caught up" (wrong: you were already) and
          // "round 2 in the books".
          celebrate(data.show.title, { round: res.round ?? round?.round ?? 2 });
        } else if (!isCaughtUp(data) && isCaughtUp(next)) celebrate(data.show.title);
      }
      return true;
    } catch (e) {
      toast(errText(e, failure), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Start a rewatch. One confirm (Letterboxd-grade friction: enough to be
  // deliberate, never enough to be a chore) whose whole job is to answer the
  // question every tracker's users ask first — does this wipe anything? It
  // doesn't, and the copy says so before the tap, not after.
  const startRewatch = async () => {
    const next = rounds + 2; // round 2 is the first rewatch
    const first = seasons.find((s) => s.number > 0)?.episodes.find((e) => e.aired);
    const ok = await confirm({
      title: "Watch it again?",
      message:
        `${first ? `Round ${next} starts at ${epCode(first.season_number, first.number)}. ` : ""}` +
        "Everything you’ve already watched stays watched — this just tracks the rerun.",
      confirmLabel: `Start round ${next}`,
      cancelLabel: "Not now",
    });
    if (!ok) return;
    // The one moment the user actually committed to. The round chip can take
    // a couple of seconds to arrive on a slow connection, so the button says
    // what it's doing while the request is out and a toast confirms the round
    // opened — a dialog that just closes reads as a tap that did nothing.
    setStarting(true);
    const done = await run(
      () => post(`/shows/${show.id}/rewatch`),
      (d, res) =>
        startedRound(d, { round: res.round ?? next, startedAt: res.startedAt ?? new Date().toISOString(), roundWatched: 0 }),
      // Every season collapsed while caught up; the round reopens the one
      // it starts in so the first tick is right there.
      (n) => setOpenSeason(pickOpenSeason(n)),
      "Couldn’t start the rewatch"
    )();
    setStarting(false);
    if (done) toast(`Round ${next}. From the top.`);
  };

  // Stop a rewatch — the visible undo, sitting right beside the round's own
  // progress bar rather than behind a menu the way Trakt hides its equivalent.
  // The confirm names BOTH sides honestly: the watch history survives (the
  // question everyone actually has), and the round's own progress does not —
  // the server deletes the round row, so there is no resuming it. Saying only
  // the reassuring half would be the reason someone loses 13 episodes of
  // progress, so this is a danger confirm: red button, cancel focused.
  const stopRewatch = async () => {
    if (!round) return;
    // A round with nothing logged in it costs nothing to drop, so that
    // dialog doesn't dress up as a destructive one.
    const loses = round.roundWatched > 0;
    const ok = await confirm({
      title: "Stop this rewatch?",
      message: loses
        ? `Round ${round.round} is at ${round.roundWatched}/${progress.aired} — that progress goes away, ` +
          "and starting again begins from scratch. Your watch history stays: every episode you’ve " +
          "ever watched stays watched, plays and all."
        : `Round ${round.round} hasn’t logged an episode yet, so there’s nothing here to lose. ` +
          "Your watch history stays either way.",
      confirmLabel: `Stop round ${round.round}`,
      cancelLabel: "Keep rewatching",
      danger: loses,
    });
    if (!ok) return;
    const done = await run(
      () => del(`/shows/${show.id}/rewatch`),
      (d) => endedRound(d, false),
      (n) => setOpenSeason(pickOpenSeason(n)),
      "Couldn’t stop the rewatch"
    )();
    if (done) toast(`Round ${round.round} stopped. Your history is untouched.`);
  };

  // Marking an episode with earlier unwatched episodes offers to catch up on
  // them too (regular seasons only — never specials). Mid-round the tick being
  // toggled is the ROUND's, so the catch-up offer counts the round's gaps.
  //
  // Un-ticking sends the SCOPE of what the tap meant, and the server does
  // exactly that and nothing more:
  //   - mid-round → 'round': this round's play comes off, the episode stays
  //     watched, every earlier date survives. No dialog: one tap back.
  //   - outside a round → 'all': the plain unwatch this checkbox has always
  //     been... but only after asking, when there is dated history to lose.
  //     An episode with two plays is one you watched in 2016 and again last
  //     week; silently deleting both because a checkbox went from ✓ to ▢ is
  //     the exact thing the rewatch dialog promises never happens. (The
  //     episode page's Watch history is where a single play comes off.)
  const toggleEpisode = async (e: Episode) => {
    if (isTicked(e, round)) {
      if (round) {
        return run(
          () => del(`/episodes/${e.id}/watch`, { scope: "round" }),
          (d) => applyWatch(d, (x) => x.id === e.id, false)
        )();
      }
      const plays = e.playCount ?? 1;
      if (plays > 1) {
        const ok = await confirm({
          title: "Unwatch this episode?",
          message: (
            <>
              All <strong>{plays} plays</strong> in your watch history go with it — every date, not just the last
              one. To take back one play and keep the rest, open the episode.
            </>
          ),
          confirmLabel: "Unwatch",
          cancelLabel: "Keep it",
          danger: true,
        });
        if (!ok) return;
      }
      return run(
        () => del(`/episodes/${e.id}/watch`, { scope: "all" }),
        (d) => applyWatch(d, (x) => x.id === e.id, false)
      )();
    }
    const prior = e.season_number > 0 ? priorUnwatched(data, e) : 0;
    if (prior > 0) {
      const catchUp = await confirm({
        title: "Catch up on earlier episodes?",
        message: round
          ? prior === 1
            ? `1 earlier episode isn’t in round ${round.round} yet.`
            : `${prior} earlier episodes aren’t in round ${round.round} yet.`
          : prior === 1
            ? "1 earlier episode is still unwatched."
            : `${prior} earlier episodes are still unwatched.`,
        confirmLabel: `Mark all ${prior + 1} watched`,
        cancelLabel: "Just this one",
      });
      if (catchUp === null) return; // dismissed — change nothing
      if (catchUp) {
        return run(
          () => post(`/shows/${show.id}/watch-until`, { season: e.season_number, number: e.number }),
          (d) => applyWatch(d, (x) => x.season_number > 0 && (isBefore(x, e) || x.id === e.id), true)
        )();
      }
    }
    return run(
      () => post(`/episodes/${e.id}/watch`),
      (d) => applyWatch(d, (x) => x.id === e.id, true)
    )();
  };

  // Hide/unhide from the viewer's public surfaces: profile
  // history rows, public library, activity feed, also-watching, and
  // notifications about the show — while it stays fully intact right here and
  // in their own Library. The toast announces the new
  // state, matching the profile privacy eye; errors toast too, like
  // togglePrivacy there.
  const toggleHidden = async () => {
    const next = !mine.hidden;
    // Only the flag changes client-side: hiding an unfollowed show writes a
    // server-side tombstone row, not a follow, so followed/state stay put.
    const done = await run(
      () => put(`/shows/${show.id}/hidden`, { hidden: next }),
      (d) => withUser(d, { hidden: next }),
      undefined,
      "Couldn't update this show"
    )();
    if (done) toast(next ? "Hidden from your public profile" : "Visible on your public profile");
  };

  // Remove the show entirely — for accidental adds. Confirms first because it
  // throws away watch history that unfollow would otherwise keep.
  const removeShow = async () => {
    const ok = await confirm({
      title: "Remove from your account?",
      message: "This erases your watch history, rating, and progress for this show. This can’t be undone.",
      confirmLabel: "Remove",
      cancelLabel: "Keep",
      danger: true,
    });
    if (ok) run(() => del(`/shows/${show.id}/remove`), cleared)();
  };

  // Unfollow — and, for a show you're partway through, ABANDON it.
  // The standalone "Abandon show" button is gone, so unfollow carries that flow:
  // a partially-watched show (some aired regular-season episodes watched but not
  // caught up — the rule the server re-checks) drops into the abandoned
  // 'stopped' state and stays in the Library's Abandoned tab, with every season
  // collapsing (keyed off state 'stopped'). Anything else — nothing
  // watched, fully caught up, or a hidden row — unfollows outright, dropping the
  // library row while keeping watch history, exactly as before. The optimistic
  // update mirrors the server's DELETE /shows/:id/follow branch.
  const unfollow = () => {
    const abandons = !mine.hidden && progress.watched > 0 && !isCaughtUp(data);
    return run(
      () => del(`/shows/${show.id}/follow`),
      (d) => (abandons ? withUser(d, { state: "stopped" }) : withUser(d, { followed: false, state: null }))
    )();
  };

  // The sweep control, mid-round scoped to the round (the server marks only
  // what the round is missing). Built here because mid-rewatch it renders
  // inside the actions group beside Stop rewatch, and outside one it stands
  // alone in the progress row exactly as it always has.
  const markAll =
    (round ? round.roundWatched : progress.watched) < progress.aired ? (
      <button
        className="link-btn"
        onClick={run(() => post(`/shows/${show.id}/watch-all`), (d) => applyWatch(d, (e) => e.season_number > 0, true))}
        disabled={busy}
      >
        Mark all watched
      </button>
    ) : null;

  return (
    <div className="show-page">
      <section
        className="show-hero"
        style={show.backdrop ? { backgroundImage: `url(${backdrop(show.backdrop)})` } : undefined}
      >
        <div className="show-hero-scrim">
          <div className="show-hero-inner">
            {show.poster && <img className="show-poster" src={poster(show.poster)!} alt="" />}
            <div className="show-hero-text">
              <h1>{show.title}</h1>
              <p className="show-facts">
                {[show.firstAirDate?.slice(0, 4), show.status, show.genres.join(", ")].filter(Boolean).join(" · ")}
              </p>
              {nextEpisode && (
                <p className="next-chip">
                  <span className="on-air-dot" aria-hidden="true" />
                  Next: <Slate season={nextEpisode.season_number} number={nextEpisode.number} />{" "}
                  {fmtAirDate(nextEpisode.air_date, tz)}
                </p>
              )}
              <div className="show-actions">
                {mine.followed && mine.state !== "watch_later" ? (
                  <>
                    <button className="btn btn-ghost" onClick={unfollow} disabled={busy}>
                      Following ✓
                    </button>
                    {mine.state === "stopped" && (
                      // A show abandoned by unfollowing reads as
                      // still followed (state 'stopped'); Resume takes it back to
                      // 'watching'. There is no separate Abandon button anymore —
                      // unfollowing a partially-watched show is what abandons it.
                      <button
                        className="btn btn-ghost"
                        onClick={run(() => put(`/shows/${show.id}/state`, { state: "watching" }), (d) => withUser(d, { state: "watching" }))}
                        disabled={busy}
                      >
                        Resume watching
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      className="btn"
                      onClick={run(() => put(`/shows/${show.id}/follow`), (d) => withUser(d, { followed: true, state: "watching" }))}
                      disabled={busy}
                    >
                      <IconPlus size={16} /> Follow
                    </button>
                    {!mine.followed && (
                      <button
                        className="btn btn-ghost"
                        onClick={run(() => put(`/shows/${show.id}/watchlist`), (d) => withUser(d, { followed: true, state: "watch_later" }))}
                        disabled={busy}
                      >
                        <IconBookmark size={16} /> Watch later
                      </button>
                    )}
                  </>
                )}
                {/* The rewatch entry point, and the reason it sits right
                    here in the actions row rather than behind a menu: Trakt
                    hid "start rewatching" behind a filter for years and it
                    became its single loudest complaint. Offered whenever
                    there's nothing left to watch (the same caught-up test
                    that collapses the seasons) and no round is already
                    running. */}
                {isCaughtUp(data) && !round && (
                  <button className="btn btn-ghost rewatch-btn" onClick={startRewatch} disabled={busy}>
                    {/* Drawn, not typed. The literal "↻" (U+21BB) has no glyph
                        in the app's faces, so the fallback rendered a thin
                        open hook whose arrowhead points the WRONG WAY — the
                        two most-looked-at rewatch affordances were the only
                        two wearing it, while every badge elsewhere drew
                        IconRewatch. One mark for one feature. */}
                    <span className={`rewatch-glyph${starting ? " is-spinning" : ""}`} aria-hidden="true">
                      <IconRewatch size={13} />
                    </span>{" "}
                    {starting ? `Starting round ${rounds + 2}…` : "Watch again"}
                  </button>
                )}
                <button
                  className={`heart-btn${mine.favorited ? " is-on" : ""}`}
                  aria-pressed={mine.favorited}
                  aria-label={mine.favorited ? "Remove from favorites" : "Add to favorites"}
                  title={mine.favorited ? "Remove from favorites" : "Add to favorites"}
                  disabled={busy}
                  onClick={run(
                    () => (mine.favorited ? del(`/shows/${show.id}/favorite`) : put(`/shows/${show.id}/favorite`)),
                    (d) => withUser(d, { favorited: !d.user?.favorited })
                  )}
                >
                  {mine.favorited ? <IconHeart size={18} /> : <IconHeartOutline size={18} />}
                </button>
                {/* Privacy toggle: icon-only like the profile's
                    privacy toggle. The hat-and-glasses "incognito"
                    glyph reads as hide-from-public; the `is-on`
                    state + aria-pressed carry hidden vs visible. Offered
                    whenever the show has any trace in the account (inLibrary),
                    since watch history alone is what leaks on the profile. */}
                {inLibrary && (
                  <button
                    className={`hide-btn${mine.hidden ? " is-on" : ""}`}
                    aria-pressed={!!mine.hidden}
                    aria-label={
                      mine.hidden
                        ? "Hidden from your public profile. Make it visible"
                        : "Visible on your public profile. Hide it"
                    }
                    title={
                      mine.hidden
                        ? "Hidden from your public profile and activity. Click to show it again"
                        : "Visible on your public profile and activity. Click to hide it"
                    }
                    disabled={busy}
                    onClick={toggleHidden}
                  >
                    <IconHatGlasses size={18} />
                  </button>
                )}
                <AddToList type="show" id={show.id} />
                <ShareButton
                  title={show.title}
                  text={`Check out ${show.title} on Show Us TV.`}
                  path={mediaPath("show", show.id, show.title)}
                />
                {inLibrary && (
                  <button
                    className="remove-btn"
                    aria-label="Remove from library"
                    title="Remove from library"
                    onClick={removeShow}
                    disabled={busy}
                  >
                    <IconTrash size={18} />
                  </button>
                )}
              </div>
              {/* Dual progress. Mid-round the bar and the loud number are
                  the ROUND's, and lifetime progress stays visible beside
                  them — always, on every screen. (Trakt's is a hover
                  tooltip, so phones never see it at all.) Outside a round
                  this is the row it has always been, plus the times-through
                  count once a rerun has actually finished. */}
              <div className={`show-progress${round ? " is-rewatching" : ""}`}>
                {round && (
                  <span className="rewatch-chip">
                    <span className="rewatch-glyph" aria-hidden="true">
                      <IconRewatch size={12} />
                    </span>
                    <span className="sr-only">Rewatch </span>
                    ROUND {round.round}
                  </span>
                )}
                {/* The bar is the round's mid-rewatch, so it says so: without
                    a label a screen reader hears "3 percent" and has no way
                    to know whether that's this round or a lifetime that just
                    ran backwards. valuetext carries the raw counts the sighted
                    readout beside it gets. */}
                <Progress
                  watched={round ? round.roundWatched : progress.watched}
                  total={progress.aired}
                  label={round ? `Round ${round.round} progress` : "Watch progress"}
                  valueText={
                    round
                      ? `${round.roundWatched} of ${progress.aired} episodes watched in round ${round.round}`
                      : `${progress.watched} of ${progress.aired} aired episodes watched`
                  }
                />
                {round ? (
                  // Both numbers travel together so a narrow screen wraps the
                  // pair onto one line instead of stranding one of them. The
                  // round's count needs no "round 2" suffix — the chip two
                  // inches to its left is already saying it — but it does need
                  // its start date: a round is a dated session, not a counter.
                  <span className="rewatch-readout">
                    {/* The separator between the two readouts hangs off THIS
                        one, not off the front of the next: as a leading
                        ::before it wrapped down to a second line at 320px and
                        opened it with an orphaned interpunct. */}
                    <span className="mono rewatch-count">
                      {round.roundWatched}/{progress.aired}
                      <span className="rewatch-since"> · since {shortDate(round.startedAt, tz)}</span>
                    </span>
                    {/* Not "first watch": after any completed round this number
                        covers every watch-through, and the ×N beside it says
                        how many there have been — mid-round too, where it used
                        to disappear entirely. The word "lifetime" is the whole
                        explanation, which is why the `title` that used to
                        carry it (and never fired on a phone) is gone — and why
                        the Library card says "lifetime" too, rather than
                        inventing a third state called "seen". */}
                    <span className="mono rewatch-lifetime">
                      lifetime {progress.watched}/{progress.aired}
                      {rounds > 0 && (
                        <>
                          <span aria-hidden="true">{` · watched ×${rounds + 1}`}</span>
                          <span className="sr-only">{` · watched ${rounds + 1} times through`}</span>
                        </>
                      )}
                    </span>
                  </span>
                ) : (
                  <span className="mono">
                    {progress.watched}/{progress.aired} aired episodes
                    {rounds > 0 && (
                      // The sentence a mouse used to get from a `title` is in
                      // the accessible name now — tooltips never fire on
                      // touch, and this is the number the whole feature is
                      // about. "×N" here counts times through the SHOW; the
                      // episode rows below count plays of one EPISODE and say
                      // so in words, so the two can't be read as the same
                      // unit any more.
                      <span className="rewatch-total">
                        {" "}
                        <span aria-hidden="true">· watched ×{rounds + 1}</span>
                        <span className="sr-only">· watched {rounds + 1} times through</span>
                        {/* The finished round's own date — the trace TV Time
                            never kept, and the reason "×2" means something. */}
                        {mine.lastRound && ` · round ${mine.lastRound.round} done ${shortDate(mine.lastRound.finishedAt, tz)}`}
                      </span>
                    )}
                  </span>
                )}
                {/* Mark all watched works on the round mid-rewatch — the
                    server sweeps only what the round is missing. Mid-round it
                    travels with Stop rewatch as one group, so a width that
                    wraps the row keeps the two controls side by side instead
                    of splitting the pair across lines. */}
                {round ? (
                  <span className="rewatch-actions">
                    {markAll}
                    <button className="link-btn rewatch-stop" onClick={stopRewatch} disabled={busy}>
                      Stop rewatch
                    </button>
                  </span>
                ) : (
                  markAll
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {show.overview && <p className="show-overview">{show.overview}</p>}

      <AlsoWatching showId={id} />

      <div className="rating-row">
        <StarRating
          value={mine.rating?.score ?? null}
          disabled={busy}
          onPick={(score) =>
            run(
              () => put("/ratings", { target_type: "show", target_id: show.id, score }),
              (d) => withUser(d, { rating: { score } })
            )()
          }
          onClear={() =>
            run(
              () => del(`/ratings/show/${show.id}/score`),
              // The star widget only shows the score; drop it locally. The server
              // keeps the row's created_at / any legacy reaction, which a later
              // reload reconciles.
              (d) => withUser(d, { rating: null })
            )()
          }
        />
      </div>

      <WhereToWatch watch={watch} title={show.title} />

      <ExternalLinks title={show.title} imdbId={show.imdbId} />

      {visibleSeasons.length > 0 && <EpisodeSortBar sort={episodeSort} onChange={changeEpisodeSort} />}

      <section className="seasons">
        {visibleSeasons.map((season) => {
          const aired = season.episodes.filter((e) => e.aired);
          // Round-scoped mid-rewatch: the count, the green season check and
          // the Mark/Clear season toggle all describe THIS round. Season bulk
          // marking during a rewatch is the thing Trakt v3 removed and its
          // users revolted over — here it just keeps working.
          const watchedCount = aired.filter((e) => isTicked(e, round)).length;
          const open = openSeason === season.number;
          const seasonDone = aired.length > 0 && watchedCount === aired.length;
          return (
            <div key={season.id} className="season">
              <div className="season-head">
                <button
                  type="button"
                  className="season-toggle"
                  aria-expanded={open}
                  onClick={() => setOpenSeason(open ? null : season.number)}
                >
                  <IconChevron size={14} />
                  <span className="season-name">{season.name ?? `Season ${season.number}`}</span>
                  {seasonDone && (
                    // In the a11y tree, not a `title`: a tooltip never fires
                    // on touch, and the sighted version of this sentence is
                    // already right here — a green check beside a mono count
                    // that reads N/N.
                    <span className="season-done">
                      <IconCheck size={13} />
                      <span className="sr-only">
                        {round ? `All aired episodes watched in round ${round.round}. ` : "All aired episodes watched. "}
                      </span>
                    </span>
                  )}
                  <span className="mono season-count">
                    {watchedCount}/{aired.length}
                  </span>
                </button>
                {aired.length > 0 &&
                  (seasonDone ? (
                    <button
                      className="link-btn"
                      onClick={run(
                        // Same scoped un-tick as a single episode, for the
                        // same reason: this route is queued offline too, and
                        // "clear this season's round marks" must never replay
                        // as "delete this season's history".
                        () =>
                          del(`/shows/${show.id}/seasons/${season.number}/watch`, { scope: round ? "round" : "all" }),
                        (d) => applyWatch(d, (e) => e.season_number === season.number, false)
                      )}
                      disabled={busy}
                    >
                      Clear season
                      {/* The reassurance that used to live in a `title` — the
                          one place it could never be read on a phone. */}
                      {round && (
                        <span className="sr-only">{` — round ${round.round}'s marks only; earlier watches stay`}</span>
                      )}
                    </button>
                  ) : (
                    <button
                      className="link-btn"
                      onClick={run(
                        () => post(`/shows/${show.id}/seasons/${season.number}/watch`),
                        (d) => applyWatch(d, (e) => e.season_number === season.number, true)
                      )}
                      disabled={busy}
                    >
                      <IconCheck size={14} /> Mark season
                    </button>
                  ))}
              </div>
              {open && (
                <ul className="episode-list">
                  {season.episodes.map((e) => {
                    // The tick is the round's while one is open — so mid-round
                    // an episode you've watched before reads as untouched
                    // unless the row says otherwise. It does, on every such
                    // row: a ghosted check in the box (see .was-watched) and
                    // its lifetime play count beside the date. Both are driven
                    // by `watched`, NOT by playCount > 1 — a show watched
                    // exactly once has playCount 1, and that is precisely the
                    // show a first rewatch starts from.
                    const ticked = isTicked(e, round);
                    const plays = e.playCount ?? 0;
                    const everWatched = !!round && !ticked && !!e.watched;
                    // ×N: every ever-watched row carries it mid-round (×1
                    // included — one watch is a real record), only genuine
                    // repeats outside one, where the green check already says
                    // "seen" and ×1 on every row would be noise.
                    const badge = everWatched ? Math.max(plays, 1) : plays > 1 ? plays : 0;
                    return (
                      <li
                        key={e.id}
                        className={`episode-row${ticked ? " is-watched" : ""}${everWatched ? " was-watched" : ""}${e.aired ? "" : " is-future"}`}
                      >
                        <Slate season={e.season_number} number={e.number} />
                        <Link to={mediaPath("episode", e.id, e.title)} className="episode-title">
                          {e.title ?? `Episode ${e.number}`}
                        </Link>
                        <span className="episode-date mono">{fmtEpisodeDate(e.air_date, e.aired, tz)}</span>
                        {/* TV Time's beloved play counter, kept calm — a pill,
                            not a suffix on the air date. It carries its UNIT
                            now: as a bare "×3" it sat 40px under a hero
                            reading "watched ×2", two mono ×N's in one
                            viewport counting different things (times through
                            the show up there, plays of this one episode down
                            here) and guaranteed to disagree. "3 plays" is
                            also exactly what the episode page's history calls
                            them, so the number a tap on this row leads to is
                            the number printed on it.
                            No `title` either: it never fires on touch, and the
                            visible words now say everything it did. */}
                        {badge > 0 && (
                          <span className="mono play-badge">
                            {badge} {badge === 1 ? "play" : "plays"}
                          </span>
                        )}
                        {e.aired ? (
                          <CheckButton
                            checked={ticked}
                            disabled={busy}
                            label={
                              ticked
                                ? round
                                  ? `Undo this episode for round ${round.round}`
                                  : "Mark unwatched"
                                : round
                                  ? `${everWatched ? "Watched before. " : ""}Mark watched for round ${round.round}`
                                  : "Mark watched"
                            }
                            onToggle={() => toggleEpisode(e)}
                          />
                        ) : (
                          <span className="on-air-dot on-air-dot--future" title="Not aired yet" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <Comments targetType="show" targetId={show.id} />
    </div>
  );
}
