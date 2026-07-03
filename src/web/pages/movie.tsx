import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useApi } from "../hooks";
import { mediaPath, idFromParam } from "../paths";
import { post, put, del } from "../api";
import { useAuth } from "../app";
import { poster, providerLogo } from "../img";
import { fmtAirDate, fmtDateTime, runtimeStr } from "../format";
import { Spinner, ErrorNote, ScorePicker, EmojiPicker } from "../components/ui";
import { IconCheck, IconBookmark } from "../components/icons";
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
  };
  user: {
    state: "watchlist" | "watched" | null;
    watchedAt: string | null;
    playCount: number;
    rating: { score: number | null; emoji: string | null } | null;
  };
  providers: { name: string; logo: string | null }[];
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

  useEffect(() => setQueuedState(null), [data]); // fresh data supersedes the override

  // Canonicalize the address bar to the slugged URL (issue #11) so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("movie", data.movie.id, data.movie.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { movie, user: mine, providers } = data;
  const tz = user!.tz;
  const state = queuedState ? (queuedState === "watched" ? "watched" : null) : mine.state;

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
                  Watched ✓ — undo
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
                    On watchlist ✓ — remove
                  </button>
                ) : (
                  <button className="btn btn-ghost" onClick={act(() => put(`/movies/${movie.id}/watchlist`))} disabled={busy}>
                    <IconBookmark size={16} /> Watch later
                  </button>
                )}
              </>
            )}
            <AddToList type="movie" id={movie.id} />
          </div>
          {state === "watched" && mine.watchedAt && (
            <p className="watched-note mono">
              Watched {fmtDateTime(mine.watchedAt, tz)}
              {mine.playCount > 1 ? ` · ${mine.playCount} plays` : ""}
            </p>
          )}

          <div className="rating-row">
            <ScorePicker
              value={mine.rating?.score ?? null}
              onPick={(score) => act(() => put("/ratings", { target_type: "movie", target_id: movie.id, score }))()}
            />
            <EmojiPicker
              value={mine.rating?.emoji ?? null}
              onPick={(emoji) => act(() => put("/ratings", { target_type: "movie", target_id: movie.id, emoji }))()}
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
        </div>
      </div>
    </div>
  );
}
