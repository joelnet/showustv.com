import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { useApi } from "../hooks";
import { post, put, del } from "../api";
import { useAuth } from "../app";
import { still } from "../img";
import { fmtAirDate, fmtDateTime, runtimeStr } from "../format";
import { Slate, Spinner, ErrorNote, ScorePicker, EmojiPicker } from "../components/ui";
import { IconCheck } from "../components/icons";

interface EpisodePayload {
  episode: {
    id: number;
    showId: number;
    showTitle: string;
    season: number;
    number: number;
    title: string | null;
    airDate: string | null;
    runtime: number | null;
    overview: string | null;
    still: string | null;
  };
  user: {
    watched: boolean;
    watchedAt: string | null;
    playCount: number;
    rating: { score: number | null; emoji: string | null } | null;
  };
}

export function EpisodePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<EpisodePayload>(`/episodes/${id}`);
  const [busy, setBusy] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { episode: ep, user: mine } = data;
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
    <div className="episode-page">
      <Link to={`/show/${ep.showId}`} className="crumb">
        ‹ {ep.showTitle}
      </Link>
      <div className="episode-head">
        {ep.still && <img className="episode-still" src={still(ep.still)!} alt="" />}
        <div>
          <div className="episode-slate-row">
            <Slate season={ep.season} number={ep.number} />
            <span className="mono episode-date">{fmtAirDate(ep.airDate, tz)}</span>
            {ep.runtime ? <span className="mono">{runtimeStr(ep.runtime)}</span> : null}
          </div>
          <h1>{ep.title ?? `Episode ${ep.number}`}</h1>
          {ep.overview && <p className="episode-overview">{ep.overview}</p>}

          <div className="episode-actions">
            {mine.watched ? (
              <>
                <button className="btn btn-ghost" onClick={act(() => del(`/episodes/${ep.id}/watch`))} disabled={busy}>
                  Watched ✓ — undo
                </button>
                <button className="btn btn-ghost" onClick={act(() => post(`/episodes/${ep.id}/watch`))} disabled={busy}>
                  + Rewatch
                </button>
              </>
            ) : (
              <button className="btn" onClick={act(() => post(`/episodes/${ep.id}/watch`))} disabled={busy}>
                <IconCheck size={16} /> Mark watched
              </button>
            )}
          </div>
          {mine.watched && mine.watchedAt && (
            <p className="watched-note mono">
              Watched {fmtDateTime(mine.watchedAt, tz)}
              {mine.playCount > 1 ? ` · ${mine.playCount} plays` : ""}
            </p>
          )}

          <div className="rating-row">
            <ScorePicker
              value={mine.rating?.score ?? null}
              onPick={(score) => act(() => put("/ratings", { target_type: "episode", target_id: ep.id, score }))()}
            />
            <EmojiPicker
              value={mine.rating?.emoji ?? null}
              onPick={(emoji) => act(() => put("/ratings", { target_type: "episode", target_id: ep.id, emoji }))()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
