import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useApi, useDocumentTitle } from "../hooks";
import { mediaPath, idFromParam } from "../paths";
import { post, put, del } from "../api";
import { useAuth } from "../app";
import { poster } from "../img";
import { fmtAirDate, fmtDateTime, runtimeStr } from "../format";
import { useConfirm } from "../components/dialog";
import { useToast } from "../components/toast";
import { ErrorNote, StarRating, ExternalLinks } from "../components/ui";
import { MediaDetailSkeleton } from "../components/skeleton";
import { WhereToWatch, type WatchInfo } from "../components/where-to-watch";
import { IconCheck, IconBookmark, IconHeart, IconHeartOutline } from "../components/icons";
import { ShareButton } from "../components/share";
import { Comments } from "../components/comments";
import { WatchHistory, type Play, type PendingPlay } from "../components/watch-history";
import { AddToList } from "./lists";

interface MoviePayload {
  movie: {
    id: number;
    title: string;
    releaseDate: string | null;
    runtime: number | null;
    poster: string | null;
    overview: string | null;
    genres: string[];
    imdbId: string | null;
  };
  // Null on the anonymous payload — the server never ships
  // user-shaped fields without a session.
  user: {
    state: "watchlist" | "watched" | null;
    watchedAt: string | null;
    playCount: number;
    // The newest 25 dated plays (0043), newest first — the Letterboxd case:
    // no rounds, just the dates you saw it on — and `playsTotal`, how many
    // there are in all. A comfort movie logged weekly for years is capped in
    // the payload, not silently truncated: the block says what's missing.
    plays: Play[];
    playsTotal?: number;
    rating: { score: number | null } | null;
    favorited: boolean;
  } | null;
  watch: WatchInfo;
}

export function MoviePage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error, reload } = useApi<MoviePayload>(`/movies/${id}`);
  const [busy, setBusy] = useState(false);
  // Watched-state override while a change is queued offline — refetching
  // would just serve the stale pre-change cache and visually revert it.
  const [queuedState, setQueuedState] = useState<"watched" | "unwatched" | null>(null);
  // Optimistic favorite state while an offline toggle is queued (matches shows).
  const [favedOverride, setFavedOverride] = useState<boolean | null>(null);
  // Plays the server hasn't confirmed yet, standing in as provisional rows so
  // a "+ Rewatch" tap has a receipt the instant it happens — queued offline,
  // or a POST still in flight online. Removal has always been optimistic (the
  // row drops before the DELETE resolves); logging was two sequential round
  // trips with nothing on screen in between.
  const [pending, setPending] = useState<PendingPlay[]>([]);
  // After a full unwatch the control the user was on is replaced by "Mark
  // watched" — focus follows it instead of falling to the top of the page.
  const markRef = useRef<HTMLButtonElement>(null);
  const [focusMark, setFocusMark] = useState(false);

  useEffect(() => {
    setQueuedState(null); // fresh data supersedes the overrides
    setFavedOverride(null);
    setPending((p) => {
      if (!p.length) return p;
      // Retire a provisional row when the server's count has grown past what
      // it was when the tap happened — the same rule online and queued. NOT a
      // timestamp match: reload() repaints the stale cached payload before the
      // network answers (which would yank the row for a frame), a skewed
      // client clock never matches the server's own stamp, and the "within
      // 60s" fuzz the queued rows used claimed the wrong play outright when
      // two plays landed inside a minute — the second tap's row vanished the
      // instant it appeared.
      const serverCount = data?.user?.playCount ?? 0;
      const next = p.filter((x) => serverCount <= x.base);
      return next.length === p.length ? p : next;
    });
  }, [data]);

  // Waits out both the in-flight request (the button is disabled while busy,
  // and a disabled button can't take focus) and the confirm <dialog>, which
  // restores focus to the button it was opened from — the one this unwatch
  // just replaced — in a task after `close`.
  useEffect(() => {
    if (!focusMark || busy) return;
    markRef.current?.focus();
    const t = window.setTimeout(() => {
      markRef.current?.focus();
      setFocusMark(false);
    }, 80);
    return () => window.clearTimeout(t);
  }, [focusMark, busy]);

  // Canonicalize the address bar to the slugged URL so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("movie", data.movie.id, data.movie.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  // Tab title — matches the <title> the Worker bakes into a
  // hard load of this page.
  useDocumentTitle(data?.movie.title);

  if (loading) return <MediaDetailSkeleton kind="movie" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { movie, watch } = data;
  // No profile timezone without a session — the browser's own stands in for
  // signed-out visitors on shared links.
  const tz = user ? user.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Signed-out visitors (shared links): public catalog content
  // with a sign-in CTA in place of the tracking controls. The anonymous
  // payload carries no user state to render.
  if (!user) {
    return (
      <div className="movie-page">
        <div className="movie-head">
          {movie.poster && <img className="show-poster" src={poster(movie.poster)!} alt="" />}
          <div>
            <h1>{movie.title}</h1>
            <p className="show-facts">
              {[movie.releaseDate && fmtAirDate(movie.releaseDate, tz), runtimeStr(movie.runtime), movie.genres.join(", ")]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {movie.overview && <p className="show-overview">{movie.overview}</p>}

            <div className="show-actions">
              <ShareButton
                title={movie.title}
                text={`Check out ${movie.title} on Show Us TV.`}
                path={mediaPath("movie", movie.id, movie.title)}
              />
            </div>

            <WhereToWatch watch={watch} title={movie.title} />

            <ExternalLinks title={movie.title} imdbId={movie.imdbId} />
          </div>
        </div>

        {/* Movie comments read like show comments: public on a
            shared link, sign-in required only to post. */}
        <Comments targetType="movie" targetId={movie.id} />
      </div>
    );
  }

  // Signed-in requests always carry the viewer's state, but the service
  // worker can replay a payload cached before sign-in (anonymous, no user
  // fields) when the network is gone — treat that as still loading rather
  // than render tracking controls with no state behind them.
  if (!data.user) return <MediaDetailSkeleton kind="movie" />;

  const mine = data.user;
  const state = queuedState ? (queuedState === "watched" ? "watched" : null) : mine.state;
  const favorited = favedOverride ?? mine.favorited;

  async function toggleFavorite() {
    setBusy(true);
    const next = !favorited;
    try {
      const r = await (favorited ? del(`/movies/${movie.id}/favorite`) : put(`/movies/${movie.id}/favorite`));
      if (r?.queued) setFavedOverride(next); // offline: reflect it locally until sync
      else reload();
    } finally {
      setBusy(false);
    }
  }

  const act =
    (fn: () => Promise<any>, queuedAs?: "watched" | "unwatched", opts?: { logsPlay?: boolean }) => async () => {
      setBusy(true);
      // The receipt goes up BEFORE the request, not after a POST and a full
      // page refetch. Same physics as a removal, which has always dropped its
      // row without waiting.
      const optimistic: PendingPlay | null = opts?.logsPlay
        ? { ts: new Date().toISOString(), base: mine.playCount }
        : null;
      if (optimistic) setPending((p) => [...p, optimistic]);
      try {
        const r = await fn();
        // Queued offline: show the change locally; the post-sync revalidation
        // brings the server truth.
        if (r?.queued) {
          setQueuedState(queuedAs ?? queuedState);
          if (optimistic) {
            // Same row, different promise: it is in the queue now, so it says
            // "queued" and waits for the sync rather than for a refetch.
            setPending((p) => p.map((x) => (x.ts === optimistic.ts ? { ...x, queued: true } : x)));
            toast("Saved — it’ll sync when you’re back online");
          } else if (queuedAs === "unwatched") setPending([]);
        } else {
          reload();
          // No "Logged. That's 4 plays." toast: the row that just appeared IS
          // the receipt, and it carries the date, a green "just now" tag and a
          // bumped header count with it. The block announces the change from
          // its own live region. The offline case keeps its toast — there is
          // no server row to point at.
        }
      } catch (e) {
        // A failed log takes its provisional row back down — the list on
        // screen is always the history the server has.
        if (optimistic) {
          setPending((p) => p.filter((x) => x.ts !== optimistic.ts));
          toast("Couldn’t log that play", "error");
          return;
        }
        throw e; // removals and restores handle their own failures
      } finally {
        setBusy(false);
      }
    };

  const logPlay = act(() => post(`/movies/${movie.id}/watch`), "watched", { logsPlay: true });

  // Unwatching drops the row AND every dated play with it — the whole history
  // the feature promises never to destroy, sitting ~40px above the block that
  // lists it. It asks first, and says how many plays are on the line.
  const undo = async () => {
    const total = Math.max(mine.playCount, mine.playsTotal ?? mine.plays?.length ?? 0, 1);
    const only = mine.plays?.[mine.plays.length - 1]?.watchedAt ?? mine.watchedAt;
    const ok = await confirm({
      title: "Unwatch this movie?",
      message:
        total > 1 ? (
          <>
            All <strong>{total} plays</strong> in your watch history go with it — every date, not just the last one.
          </>
        ) : only ? (
          <>
            Its only play — <strong>{fmtDateTime(only, tz)}</strong> — comes off your history too.
          </>
        ) : (
          <>The movie goes back to unwatched.</>
        ),
      confirmLabel: "Unwatch",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (!ok) return;
    await act(() => del(`/movies/${movie.id}/watch`), "unwatched")();
    // The history block vanishes with the watched state, so the receipt (and
    // the screen-reader announcement — the toast is a live region) comes from
    // outside it.
    toast(total > 1 ? `Back to unwatched. ${total} plays removed.` : "Back to unwatched.");
    setFocusMark(true);
  };

  return (
    <div className="movie-page">
      <div className="movie-head">
        {movie.poster && <img className="show-poster" src={poster(movie.poster)!} alt="" />}
        <div>
          <h1>{movie.title}</h1>
          <p className="show-facts">
            {[movie.releaseDate && fmtAirDate(movie.releaseDate, tz), runtimeStr(movie.runtime), movie.genres.join(", ")]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {movie.overview && <p className="show-overview">{movie.overview}</p>}

          <div className="show-actions">
            {state === "watched" ? (
              <>
                <button className="btn btn-ghost" onClick={undo} disabled={busy}>
                  Watched ✓ (undo)
                </button>
                {/* The same words the episode page uses for the same action —
                    one more dated play of this one title. (It said
                    "+ Rewatch" here and "+ Watch again" mid-round over there,
                    for an identical tap.) */}
                <button className="btn btn-ghost" onClick={logPlay} disabled={busy}>
                  + Log a play
                  <span className="sr-only"> — another one, dated now</span>
                </button>
              </>
            ) : (
              <>
                <button className="btn" ref={markRef} onClick={logPlay} disabled={busy}>
                  <IconCheck size={16} /> Mark watched
                </button>
                {state === "watchlist" ? (
                  <button className="btn btn-ghost" onClick={act(() => del(`/movies/${movie.id}/watchlist`))} disabled={busy}>
                    On watchlist ✓ (remove)
                  </button>
                ) : (
                  <button className="btn btn-ghost" onClick={act(() => put(`/movies/${movie.id}/watchlist`))} disabled={busy}>
                    <IconBookmark size={16} /> Watch later
                  </button>
                )}
              </>
            )}
            <button
              className={`heart-btn${favorited ? " is-on" : ""}`}
              aria-pressed={favorited}
              aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
              title={favorited ? "Remove from favorites" : "Add to favorites"}
              disabled={busy}
              onClick={toggleFavorite}
            >
              {favorited ? <IconHeart size={18} /> : <IconHeartOutline size={18} />}
            </button>
            <AddToList type="movie" id={movie.id} />
            <ShareButton
              title={movie.title}
              text={`Check out ${movie.title} on Show Us TV.`}
              path={mediaPath("movie", movie.id, movie.title)}
            />
          </div>
          {/* Dated per-play history in place of the old one-line note —
              the same block the episode page uses. */}
          {state === "watched" && (
            <WatchHistory
              kind="movie"
              id={movie.id}
              plays={mine.plays ?? []}
              playCount={mine.playCount}
              playsTotal={mine.playsTotal}
              tz={tz}
              busy={busy}
              act={act}
              pending={pending}
              onUnwatched={() => {
                setQueuedState("unwatched");
                setFocusMark(true);
              }}
            />
          )}

          <div className="rating-row">
            <StarRating
              value={mine.rating?.score ?? null}
              disabled={busy}
              onPick={(score) => act(() => put("/ratings", { target_type: "movie", target_id: movie.id, score }))()}
              // Score-only clear: keeps any legacy reaction / review on the row.
              onClear={act(() => del(`/ratings/movie/${movie.id}/score`))}
            />
          </div>

          <WhereToWatch watch={watch} title={movie.title} />

          <ExternalLinks title={movie.title} imdbId={movie.imdbId} />
        </div>
      </div>

      <Comments targetType="movie" targetId={movie.id} />
    </div>
  );
}
