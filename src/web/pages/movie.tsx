import { useParams } from "react-router-dom";
import { useState } from "react";
import { useApi } from "../hooks";
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
  const { id } = useParams();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<MoviePayload>(`/movies/${id}`);
  const [busy, setBusy] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { movie, user: mine, providers } = data;
  const tz = user!.tz;

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
      reload();
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
            {mine.state === "watched" ? (
              <>
                <button className="btn btn-ghost" onClick={act(() => del(`/movies/${movie.id}/watch`))} disabled={busy}>
                  Watched ✓ — undo
                </button>
                <button className="btn btn-ghost" onClick={act(() => post(`/movies/${movie.id}/watch`))} disabled={busy}>
                  + Rewatch
                </button>
              </>
            ) : (
              <>
                <button className="btn" onClick={act(() => post(`/movies/${movie.id}/watch`))} disabled={busy}>
                  <IconCheck size={16} /> Mark watched
                </button>
                {mine.state === "watchlist" ? (
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
          {mine.state === "watched" && mine.watchedAt && (
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
