import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, post, put, del } from "../api";
import { mediaPath, idFromParam } from "../paths";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { poster, backdrop, providerLogo } from "../img";
import { fmtAirDate } from "../format";
import { Slate, Spinner, ErrorNote, Progress, CheckButton, ScorePicker, ExternalLinks } from "../components/ui";
import { Comments } from "../components/comments";
import { useCelebrate } from "../components/celebration";
import { IconCheck, IconPlus, IconChevron, IconBookmark, IconHeart, IconHeartOutline } from "../components/icons";
import { useConfirm } from "../components/dialog";
import { AddToList } from "./lists";

interface Episode {
  id: number;
  season_number: number;
  number: number;
  title: string | null;
  air_date: string | null;
  aired: boolean;
  watched: boolean;
  playCount: number;
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
  user: {
    followed: boolean;
    state: string | null;
    rating: { score: number | null; emoji: string | null } | null;
    favorited: boolean;
  };
  progress: { watched: number; aired: number; total: number };
  nextEpisode: Episode | null;
  providers: { name: string; logo: string | null }[];
}

// Apply a watched-state change locally; progress counts only aired regular
// (season > 0) episodes, matching the server's definition.
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
  return { ...d, seasons, progress: { ...d.progress, watched: d.progress.watched + delta } };
}

function withUser(d: ShowPayload, user: Partial<ShowPayload["user"]>): ShowPayload {
  return { ...d, user: { ...d.user, ...user } };
}

// Full removal (issue #20): drop the show from the account and reset every
// bit of local state it contributed — history, progress, rating, favorite.
function cleared(d: ShowPayload): ShowPayload {
  return {
    ...d,
    user: { followed: false, state: null, rating: null, favorited: false },
    progress: { ...d.progress, watched: 0 },
    seasons: d.seasons.map((s) => ({
      ...s,
      episodes: s.episodes.map((e) => ({ ...e, watched: false, playCount: 0 })),
    })),
  };
}

// Fully caught up: every aired regular-season episode is watched. Uses the
// same aired-only progress counts the server sends, so it matches the app's
// definition of "no episodes left to watch right now" (issue #53).
const isCaughtUp = (d: ShowPayload) => d.progress.aired > 0 && d.progress.watched >= d.progress.aired;

const isBefore = (e: Episode, target: Episode) =>
  e.season_number < target.season_number ||
  (e.season_number === target.season_number && e.number < target.number);

// Aired, unwatched, regular-season episodes earlier than the target.
function priorUnwatched(d: ShowPayload, target: Episode): number {
  return d.seasons
    .flatMap((s) => s.episodes)
    .filter((e) => e.season_number > 0 && e.aired && !e.watched && isBefore(e, target)).length;
}

// People you follow who track this show — username chips linking to their
// profile. Quietly renders nothing while loading, with none, or offline.
function AlsoWatching({ showId }: { showId: string }) {
  const { data } = useApi<{ following: { username: string; state: string }[] }>(`/social/also-watching/${showId}`);
  if (!data?.following.length) return null;
  const label = (state: string) =>
    state === "watch_later" ? "wants to watch" : state === "finished" || state === "up_to_date" ? "watched" : "watching";
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

export function ShowPage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const celebrate = useCelebrate();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<ShowPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openSeason, setOpenSeason] = useState<number | null>(null);

  // Canonicalize the address bar to the slugged URL (issue #11) so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("show", data.show.id, data.show.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api<ShowPayload>(`/shows/${id}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        // Open the season the viewer is currently working through.
        const current = d.seasons.find((s) => s.number > 0 && s.episodes.some((e) => e.aired && !e.watched));
        setOpenSeason(current?.number ?? d.seasons.find((s) => s.number > 0)?.number ?? null);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner />;

  const { show, seasons, user: mine, progress, nextEpisode, providers } = data;
  const tz = user!.tz;

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
    try {
      await fn();
      setData((d) => (d ? apply(d) : d));
      if (data && !isCaughtUp(data) && isCaughtUp(apply(data))) celebrate(data.show.title);
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
                    <button
                      className="btn btn-ghost"
                      onClick={run(() => del(`/shows/${show.id}/follow`), (d) => withUser(d, { followed: false, state: null }))}
                      disabled={busy}
                    >
                      Following ✓
                    </button>
                    {mine.state === "stopped" ? (
                      <button
                        className="btn btn-ghost"
                        onClick={run(() => put(`/shows/${show.id}/state`, { state: "watching" }), (d) => withUser(d, { state: "watching" }))}
                        disabled={busy}
                      >
                        Resume watching
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost"
                        onClick={run(() => put(`/shows/${show.id}/state`, { state: "stopped" }), (d) => withUser(d, { state: "stopped" }))}
                        disabled={busy}
                      >
                        Stop watching
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
                    (d) => withUser(d, { favorited: !d.user.favorited })
                  )}
                >
                  {mine.favorited ? <IconHeart size={18} /> : <IconHeartOutline size={18} />}
                </button>
                <AddToList type="show" id={show.id} />
                {inLibrary && (
                  <button className="link-btn link-btn--danger" onClick={removeShow} disabled={busy}>
                    Remove
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
        <ScorePicker
          value={mine.rating?.score ?? null}
          onPick={(score) =>
            run(
              () => put("/ratings", { target_type: "show", target_id: show.id, score }),
              (d) => withUser(d, { rating: { score, emoji: d.user.rating?.emoji ?? null } })
            )()
          }
        />
      </div>

      {providers.length > 0 && (
        <div className="providers">
          <span className="providers-label">Where to watch</span>
          {providers.map((p) =>
            p.logo ? <img key={p.name} src={providerLogo(p.logo)!} alt={p.name} title={p.name} /> : <span key={p.name}>{p.name}</span>
          )}
          <span className="justwatch">Streaming data by JustWatch</span>
        </div>
      )}

      <ExternalLinks title={show.title} imdbId={show.imdbId} />

      <section className="seasons">
        {seasons
          .filter((s) => s.episodes.length > 0)
          .map((season) => {
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
                        <span className="episode-date mono">{fmtAirDate(e.air_date, tz)}</span>
                        {e.aired ? (
                          <CheckButton
                            checked={e.watched}
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
