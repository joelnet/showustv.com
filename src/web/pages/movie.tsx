import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useApi, useDocumentTitle } from "../hooks";
import { mediaPath, idFromParam } from "../paths";
import { post, put, del } from "../api";
import { useAuth } from "../app";
import { poster } from "../img";
import { fmtAirDate, fmtDateTime, runtimeStr } from "../format";
import { ErrorNote, StarRating, ExternalLinks } from "../components/ui";
import { MediaDetailSkeleton } from "../components/skeleton";
import { WhereToWatch, type WatchInfo } from "../components/where-to-watch";
import { IconCheck, IconBookmark, IconHeart, IconHeartOutline } from "../components/icons";
import { ShareButton } from "../components/share";
import { Comments } from "../components/comments";
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
    rating: { score: number | null } | null;
    favorited: boolean;
  } | null;
  watch: WatchInfo;
}

export function MoviePage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error, reload } = useApi<MoviePayload>(`/movies/${id}`);
  const [busy, setBusy] = useState(false);
  // Watched-state override while a change is queued offline — refetching
  // would just serve the stale pre-change cache and visually revert it.
  const [queuedState, setQueuedState] = useState<"watched" | "unwatched" | null>(null);
  // Optimistic favorite state while an offline toggle is queued (matches shows).
  const [favedOverride, setFavedOverride] = useState<boolean | null>(null);

  useEffect(() => {
    setQueuedState(null); // fresh data supersedes the overrides
    setFavedOverride(null);
  }, [data]);

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

  const act = (fn: () => Promise<any>, queuedAs?: "watched" | "unwatched") => async () => {
    setBusy(true);
    try {
      const r = await fn();
      // Queued offline: show the change locally; the post-sync revalidation
      // brings the server truth.
      if (r?.queued) setQueuedState(queuedAs ?? queuedState);
      else reload();
    } finally {
      setBusy(false);
    }
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
                <button className="btn btn-ghost" onClick={act(() => del(`/movies/${movie.id}/watch`), "unwatched")} disabled={busy}>
                  Watched ✓ (undo)
                </button>
                <button className="btn btn-ghost" onClick={act(() => post(`/movies/${movie.id}/watch`), "watched")} disabled={busy}>
                  + Rewatch
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={act(() => post(`/movies/${movie.id}/watch`), "watched")} disabled={busy}>
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
          {state === "watched" && mine.watchedAt && (
            <p className="watched-note mono">
              Watched {fmtDateTime(mine.watchedAt, tz)}
              {mine.playCount > 1 ? ` · ${mine.playCount} plays` : ""}
            </p>
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
