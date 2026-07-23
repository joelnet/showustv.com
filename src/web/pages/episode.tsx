import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { useApi, useDocumentTitle } from "../hooks";
import { mediaPath, idFromParam } from "../paths";
import { post, put, del } from "../api";
import { useAuth } from "../app";
import { still } from "../img";
import { fmtDateTime, fmtEpisodeDate, runtimeStr } from "../format";
import { Slate, ErrorNote, StarRating } from "../components/ui";
import { MediaDetailSkeleton } from "../components/skeleton";
import { Comments } from "../components/comments";
import { useCelebrate } from "../components/celebration";
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
    aired: boolean;
    runtime: number | null;
    overview: string | null;
    still: string | null;
  };
  // Null on the anonymous payload — the server never ships
  // user-shaped fields without a session.
  user: {
    watched: boolean;
    watchedAt: string | null;
    playCount: number;
    rating: { score: number | null } | null;
  } | null;
}

export function EpisodePage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const celebrate = useCelebrate();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error, reload } = useApi<EpisodePayload>(`/episodes/${id}`);
  const [busy, setBusy] = useState(false);
  // Watched-state override while a change is queued offline — refetching
  // would just serve the stale pre-change cache and visually revert it.
  const [queuedState, setQueuedState] = useState<"watched" | "unwatched" | null>(null);

  useEffect(() => setQueuedState(null), [data]); // fresh data supersedes the override

  // Canonicalize the address bar to the slugged URL so bare or
  // stale-slug links become shareable SEO-friendly ones once the title loads.
  useEffect(() => {
    if (!data) return;
    const canonical = mediaPath("episode", data.episode.id, data.episode.title);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, location, navigate]);

  // Tab title — same "Show S01E05: Name" the Worker bakes into
  // a hard load of this page.
  const epMeta = data?.episode;
  useDocumentTitle(
    epMeta &&
      `${epMeta.showTitle} S${String(epMeta.season).padStart(2, "0")}E${String(epMeta.number).padStart(2, "0")}${
        epMeta.title ? `: ${epMeta.title}` : ""
      }`
  );

  if (loading) return <MediaDetailSkeleton kind="episode" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { episode: ep } = data;
  // No profile timezone without a session — the browser's own stands in for
  // signed-out visitors on shared links.
  const tz = user ? user.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Signed-out visitors (shared links): public catalog content,
  // no watch/rating controls. Comments render read-only (the thread is public
  // for a public title); the Comments component itself shows a quiet sign-in
  // line in place of the composer.
  if (!user) {
    return (
      <div className="episode-page">
        <Link to={mediaPath("show", ep.showId, ep.showTitle)} className="episode-show-link">
          {ep.showTitle}
        </Link>
        <div className="episode-head">
          {ep.still && <img className="episode-still" src={still(ep.still)!} alt="" />}
          <div>
            <div className="episode-slate-row">
              <Slate season={ep.season} number={ep.number} />
              <span className="mono episode-date">{fmtEpisodeDate(ep.airDate, ep.aired, tz)}</span>
              {ep.runtime ? <span className="mono">{runtimeStr(ep.runtime)}</span> : null}
            </div>
            <h1>{ep.title ?? `Episode ${ep.number}`}</h1>
            {ep.overview && <p className="episode-overview">{ep.overview}</p>}
          </div>
        </div>
        <Comments targetType="episode" targetId={ep.id} />
      </div>
    );
  }

  // Signed-in requests always carry the viewer's state, but the service
  // worker can replay a payload cached before sign-in (anonymous, no user
  // fields) when the network is gone — treat that as still loading rather
  // than render tracking controls with no state behind them.
  if (!data.user) return <MediaDetailSkeleton kind="episode" />;

  const mine = data.user;
  const watched = queuedState ? queuedState === "watched" : mine.watched;

  const act = (fn: () => Promise<any>, queuedAs?: "watched" | "unwatched") => async () => {
    setBusy(true);
    try {
      const r = await fn();
      // Queued offline: show the change locally; the post-sync revalidation
      // brings the server truth.
      if (r?.queued) setQueuedState(queuedAs ?? queuedState);
      else reload();
      // The watch endpoint flags when this mark just finished the show.
      // Only the mark-watched post carries it, so undo/rating never fire.
      if (r?.caughtUp) celebrate(r.showTitle ?? ep.showTitle);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="episode-page">
      <Link to={mediaPath("show", ep.showId, ep.showTitle)} className="episode-show-link">
        {ep.showTitle}
      </Link>
      <div className="episode-head">
        {ep.still && <img className="episode-still" src={still(ep.still)!} alt="" />}
        <div>
          <div className="episode-slate-row">
            <Slate season={ep.season} number={ep.number} />
            <span className="mono episode-date">{fmtEpisodeDate(ep.airDate, ep.aired, tz)}</span>
            {ep.runtime ? <span className="mono">{runtimeStr(ep.runtime)}</span> : null}
          </div>
          <h1>{ep.title ?? `Episode ${ep.number}`}</h1>
          {ep.overview && <p className="episode-overview">{ep.overview}</p>}

          <div className="episode-actions">
            {watched ? (
              <>
                <button className="btn btn-ghost" onClick={act(() => del(`/episodes/${ep.id}/watch`), "unwatched")} disabled={busy}>
                  Watched ✓ (undo)
                </button>
                <button className="btn btn-ghost" onClick={act(() => post(`/episodes/${ep.id}/watch`), "watched")} disabled={busy}>
                  + Rewatch
                </button>
              </>
            ) : (
              <button className="btn" onClick={act(() => post(`/episodes/${ep.id}/watch`), "watched")} disabled={busy}>
                <IconCheck size={16} /> Mark watched
              </button>
            )}
          </div>
          {watched && mine.watchedAt && (
            <p className="watched-note mono">
              Watched {fmtDateTime(mine.watchedAt, tz)}
              {mine.playCount > 1 ? ` · ${mine.playCount} plays` : ""}
            </p>
          )}

          <div className="rating-row">
            <StarRating
              value={mine.rating?.score ?? null}
              disabled={busy}
              onPick={(score) => act(() => put("/ratings", { target_type: "episode", target_id: ep.id, score }))()}
              // Score-only clear: keeps any legacy reaction / review on the row.
              onClear={act(() => del(`/ratings/episode/${ep.id}/score`))}
            />
          </div>
        </div>
      </div>
      <Comments targetType="episode" targetId={ep.id} />
    </div>
  );
}
