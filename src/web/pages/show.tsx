import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, post, put, del, ApiError } from "../api";
import { mediaPath, idFromParam } from "../paths";
import { useApi, useDocumentTitle, getCached, setCached, dropCached, readApiCache } from "../hooks";
import { useAuth } from "../app";
import { poster, backdrop } from "../img";
import { fmtAirDate, fmtEpisodeDate } from "../format";
import { Slate, ErrorNote, Progress, CheckButton, StarRating, ExternalLinks } from "../components/ui";
import { ShowPageSkeleton } from "../components/skeleton";
import { WhereToWatch, type WatchInfo } from "../components/where-to-watch";
import { Comments } from "../components/comments";
import { useCelebrate } from "../components/celebration";
import { IconCheck, IconPlus, IconChevron, IconBookmark, IconHeart, IconHeartOutline, IconHatGlasses, IconTrash } from "../components/icons";
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
  // Viewer state — absent on the anonymous payload (issue #159).
  watched?: boolean;
  playCount?: number;
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
  // `user` and `progress` are null on the anonymous payload (issue #159) —
  // the server never ships user-shaped fields without a session.
  user: {
    followed: boolean;
    state: string | null;
    rating: { score: number | null; emoji: string | null } | null;
    favorited: boolean;
    // Hidden from the viewer's public surfaces (issue #260). Optional so a
    // service-worker-cached pre-#260 payload still renders.
    hidden?: boolean;
  } | null;
  progress: { watched: number; aired: number; total: number } | null;
  nextEpisode: Episode | null;
  watch: WatchInfo;
}

// Apply a watched-state change locally; progress counts only aired regular
// (season > 0) episodes, matching the server's definition. Only reachable
// signed-in (anonymous viewers have no watch controls), so the null guards
// on user/progress are for the types, not a real code path.
function applyWatch(d: ShowPayload, pred: (e: Episode) => boolean, watched: boolean): ShowPayload {
  let delta = 0;
  const seasons = d.seasons.map((s) => ({
    ...s,
    episodes: s.episodes.map((e) => {
      if (!pred(e) || e.watched === watched || (watched && !e.aired)) return e;
      if (e.season_number > 0 && e.aired) delta += watched ? 1 : -1;
      return { ...e, watched, playCount: watched ? 1 : 0 };
    }),
  }));
  return { ...d, seasons, progress: d.progress && { ...d.progress, watched: d.progress.watched + delta } };
}

function withUser(d: ShowPayload, user: Partial<NonNullable<ShowPayload["user"]>>): ShowPayload {
  return { ...d, user: d.user && { ...d.user, ...user } };
}

// Full removal (issue #20): drop the show from the account and reset every
// bit of local state it contributed — history, progress, rating, favorite.
function cleared(d: ShowPayload): ShowPayload {
  return {
    ...d,
    user: { followed: false, state: null, rating: null, favorited: false, hidden: false },
    progress: d.progress && { ...d.progress, watched: 0 },
    seasons: d.seasons.map((s) => ({
      ...s,
      episodes: s.episodes.map((e) => ({ ...e, watched: false, playCount: 0 })),
    })),
  };
}

// Fully caught up: every aired regular-season episode is watched. Uses the
// same aired-only progress counts the server sends, so it matches the app's
// definition of "no episodes left to watch right now" (issue #53).
const isCaughtUp = (d: ShowPayload) =>
  d.progress != null && d.progress.aired > 0 && d.progress.watched >= d.progress.aired;

const isBefore = (e: Episode, target: Episode) =>
  e.season_number < target.season_number ||
  (e.season_number === target.season_number && e.number < target.number);

// Aired, unwatched, regular-season episodes earlier than the target.
function priorUnwatched(d: ShowPayload, target: Episode): number {
  return d.seasons
    .flatMap((s) => s.episodes)
    .filter((e) => e.season_number > 0 && e.aired && !e.watched && isBefore(e, target)).length;
}

// The season to open on load: the one the viewer is working through — the
// first regular season with an aired unwatched episode. Fully-watched seasons
// never open, and a caught-up viewer (isCaughtUp — the same aired
// regular-episode counts behind Finished/Up to date) gets every season
// collapsed instead of a force-opened one (issue #264). An abandoned show
// (state 'stopped', issue #302) collapses every season too — the viewer has
// stopped and won't be marking new episodes watched, even if aired unwatched
// ones remain — so that check comes first, before the working-season lookup.
// Only a show with nothing aired yet (and specials-only shows never counted)
// keeps the old first-regular-season fallback so upcoming air dates stay
// visible. Shared so a cache seed and a fresh fetch derive it the same way.
function pickOpenSeason(d: ShowPayload): number | null {
  // Nothing left to mark watched — collapse every season (issues #264, #302).
  if (d.user?.state === "stopped" || isCaughtUp(d)) return null;
  const current = d.seasons.find((s) => s.number > 0 && s.episodes.some((e) => e.aired && !e.watched));
  if (current) return current.number;
  return d.seasons.find((s) => s.number > 0)?.number ?? null;
}

// Episode display order (issue #187). Ascending is the server's order (season
// 1 first, E1 first). Descending mirrors both levels — latest season first,
// latest episode first within each season — so the most recent episode is the
// first row on the page; specials (season 0) fall to the bottom. One global
// preference per user, never per-show or per-season, stored under a per-user
// key like the Watch Now section layout (issue #185) so two accounts on the
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
// same styling and label placement (issue #187).
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

// Signed-out view of a show (issue #159): the public catalog content — hero,
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
  // Seed instantly from the Continue Watching precache when present (issue
  // #154 follow-up): a tile that was warmed for offline paints its detail
  // page from cache with no loading skeleton; the fetch below then refreshes
  // it in the background. A cold (unseeded) show still shows the skeleton.
  const seed = getCached<ShowPayload>(cacheKey);
  const [data, setData] = useState<ShowPayload | null>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Signed-out viewers (issue #159) start with every season collapsed; only a
  // signed-in visit auto-opens the season they're working through.
  const [openSeason, setOpenSeason] = useState<number | null>(seed && user ? pickOpenSeason(seed) : null);
  // Global episode order (issue #187): restored once per mount from the
  // per-user key and kept across show-to-show navigation — it's one setting
  // for the whole account, so no per-show reset.
  const [episodeSort, setEpisodeSort] = useState<EpisodeSort>(() => loadEpisodeSort(user?.id));
  const changeEpisodeSort = (s: EpisodeSort) => {
    setEpisodeSort(s);
    saveEpisodeSort(user?.id, s);
  };

  // Re-read the order preference if the signed-in identity changes while the
  // page stays mounted, so one account's in-memory choice can't bleed into
  // another's session (the same cross-account hygiene as issue #185).
  useEffect(() => {
    setEpisodeSort(loadEpisodeSort(user?.id));
  }, [user?.id]);
  // Once the user makes a (persisted) optimistic change, a background refetch
  // that started before it holds pre-change state — skip applying it so it
  // can't visually revert the change. The seed makes the page interactive
  // before the mount refetch lands, which is the only way they race.
  const dirty = useRef(false);

  // Canonicalize the address bar to the slugged URL (issue #11) so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("show", data.show.id, data.show.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  // Tab title (issue #211) — matches the <title> the Worker bakes into a
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
    // a stale default open (issue #264): the fresh fetch re-picks it below.
    let pickSettled = cached !== undefined && renders(cached);
    if (cached) setOpenSeason(user ? pickOpenSeason(cached) : null);
    if (cached === undefined) {
      // Cold load: paint the service worker's offline copy instantly (issue
      // #183) while the fetch below revalidates — a precached library show
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
        // Anonymous viewers keep everything collapsed (issue #159).
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

  // Signed-out visitors (shared links, issue #159): the public catalog view
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
  // mark-all, or a catch-up sweep (issue #53). Detection runs off the captured
  // `data` (single-flight thanks to `busy`), keeping the side effect out of the
  // state updater so a double-invoked render can't replay the confetti.
  const run = (fn: () => Promise<unknown>, apply: (d: ShowPayload) => ShowPayload) => async () => {
    setBusy(true);
    // The user is acting on the data on screen: a mount-time refetch still in
    // flight holds pre-change state, so guard it out now (before it can land)
    // and keep the captured `data` as the single base for both the on-screen
    // and the cached copy. This page never refetched after a mutation anyway.
    dirty.current = true;
    try {
      await fn();
      setData((d) => (d ? apply(d) : d));
      if (data) {
        const next = apply(data);
        // Keep the shared cache in step so a revisit paints the change, not
        // the pre-change seed.
        setCached(cacheKey, next);
        if (!isCaughtUp(data) && isCaughtUp(next)) celebrate(data.show.title);
      }
    } finally {
      setBusy(false);
    }
  };

  // Marking an episode with earlier unwatched episodes offers to catch up on
  // them too (regular seasons only — never specials). Unmarking never asks.
  const toggleEpisode = async (e: Episode) => {
    if (e.watched) {
      return run(
        () => del(`/episodes/${e.id}/watch`),
        (d) => applyWatch(d, (x) => x.id === e.id, false)
      )();
    }
    const prior = e.season_number > 0 ? priorUnwatched(data, e) : 0;
    if (prior > 0) {
      const catchUp = await confirm({
        title: "Catch up on earlier episodes?",
        message:
          prior === 1
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

  // Hide/unhide from the viewer's public surfaces (issue #260): profile
  // history rows, public library, activity feed, also-watching, and
  // notifications about the show — while it stays fully intact right here and
  // in their own Library. The toast (issue #244 chrome) announces the new
  // state, matching the profile privacy eye; errors toast too, like
  // togglePrivacy there.
  const toggleHidden = async () => {
    const next = !mine.hidden;
    try {
      // Only the flag changes client-side: hiding an unfollowed show writes a
      // server-side tombstone row, not a follow, so followed/state stay put.
      await run(
        () => put(`/shows/${show.id}/hidden`, { hidden: next }),
        (d) => withUser(d, { hidden: next })
      )();
      toast(next ? "Hidden from your public profile" : "Visible on your public profile");
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't update this show", "error");
    }
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

  // Unfollow — and, for a show you're partway through, ABANDON it (issue #314).
  // The standalone "Abandon show" button is gone, so unfollow carries that flow:
  // a partially-watched show (some aired regular-season episodes watched but not
  // caught up — the #258 rule the server re-checks) drops into the abandoned
  // 'stopped' state and stays in the Library's Abandoned tab, with every season
  // collapsing (#302, keyed off state 'stopped'). Anything else — nothing
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
                      // A show abandoned by unfollowing (issue #314) reads as
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
                {/* Privacy toggle (issue #260): icon-only like the profile's
                    privacy toggle (issue #244). The hat-and-glasses "incognito"
                    glyph (issue #314) reads as hide-from-public; the `is-on`
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
              <div className="show-progress">
                <Progress watched={progress.watched} total={progress.aired} />
                <span className="mono">
                  {progress.watched}/{progress.aired} aired episodes
                </span>
                {progress.watched < progress.aired && (
                  <button
                    className="link-btn"
                    onClick={run(() => post(`/shows/${show.id}/watch-all`), (d) => applyWatch(d, (e) => e.season_number > 0, true))}
                    disabled={busy}
                  >
                    Mark all watched
                  </button>
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
              (d) => withUser(d, { rating: { score, emoji: d.user?.rating?.emoji ?? null } })
            )()
          }
          onClear={() =>
            run(
              () => del(`/ratings/show/${show.id}/score`),
              // Server keeps the row (with created_at) if an emoji remains; mirror
              // that locally — otherwise the rating is gone entirely.
              (d) => withUser(d, { rating: d.user?.rating?.emoji ? { score: null, emoji: d.user.rating.emoji } : null })
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
          const watchedCount = aired.filter((e) => e.watched).length;
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
                    <span className="season-done" title="All aired episodes watched">
                      <IconCheck size={13} />
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
                        () => del(`/shows/${show.id}/seasons/${season.number}/watch`),
                        (d) => applyWatch(d, (e) => e.season_number === season.number, false)
                      )}
                      disabled={busy}
                    >
                      Clear season
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
                  {season.episodes.map((e) => (
                    <li key={e.id} className={`episode-row${e.watched ? " is-watched" : ""}${e.aired ? "" : " is-future"}`}>
                      <Slate season={e.season_number} number={e.number} />
                      <Link to={mediaPath("episode", e.id, e.title)} className="episode-title">
                        {e.title ?? `Episode ${e.number}`}
                      </Link>
                      <span className="episode-date mono">{fmtEpisodeDate(e.air_date, e.aired, tz)}</span>
                      {e.aired ? (
                        <CheckButton
                          checked={!!e.watched}
                          disabled={busy}
                          label={e.watched ? "Mark unwatched" : "Mark watched"}
                          onToggle={() => toggleEpisode(e)}
                        />
                      ) : (
                        <span className="on-air-dot on-air-dot--future" title="Not aired yet" />
                      )}
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
