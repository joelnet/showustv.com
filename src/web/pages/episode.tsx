import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
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
import { useConfirm } from "../components/dialog";
import { useToast } from "../components/toast";
import { IconCheck, IconRewatch } from "../components/icons";
import { WatchHistory, type Play, type PendingPlay, type Round } from "../components/watch-history";

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
    // The newest 25 dated plays (0043), newest first, and `playsTotal`: how
    // many dated plays exist in all. playCount can still exceed playsTotal on
    // legacy rows whose middle plays were never dated, and playsTotal can
    // exceed plays.length on a much-rewatched title — the Watch history block
    // reports both gaps instead of hiding them.
    plays: Play[];
    playsTotal?: number;
    // The show's open rewatch round, and whether this episode is already in
    // it. Null outside a round. Un-ticking means two very different things on
    // either side of this field — drop one round play, or unwatch the episode
    // outright — so the page has to know which one the button is about to do.
    rewatch: { round: number; startedAt: string; watchedThisRound: boolean } | null;
    // Every round the show has ever had, oldest first, each with the window
    // its plays fall in. The Watch history tags historic plays from this —
    // attribution used to come from the OPEN round alone, so a play stopped
    // saying which rerun it was the moment that round completed.
    rewatchRounds?: Round[];
    rating: { score: number | null } | null;
  } | null;
}

export function EpisodePage() {
  const id = idFromParam(useParams().id);
  const { user } = useAuth();
  const celebrate = useCelebrate();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error, reload } = useApi<EpisodePayload>(`/episodes/${id}`);
  const [busy, setBusy] = useState(false);
  // Watched-state override while a change is queued offline — refetching
  // would just serve the stale pre-change cache and visually revert it.
  const [queuedState, setQueuedState] = useState<"watched" | "unwatched" | null>(null);
  // Plays the server hasn't confirmed yet, standing in as provisional rows so
  // a "+ Rewatch" tap has a receipt the instant it happens — queued offline,
  // or a POST still in flight online. Removal has always been optimistic
  // (the row drops before the DELETE resolves); logging was two sequential
  // round trips with nothing on screen in between, so the same list ran on
  // two different physics depending on which way you pushed it.
  const [pending, setPending] = useState<PendingPlay[]>([]);
  // After a full unwatch the control the user was on is replaced by "Mark
  // watched" — focus follows it instead of falling to the top of the page.
  const markRef = useRef<HTMLButtonElement>(null);
  const [focusMark, setFocusMark] = useState(false);

  useEffect(() => {
    setQueuedState(null); // fresh data supersedes the override
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
  // The show's open rewatch round, if any. Mid-round a queued (offline) mark
  // counts for the round the moment it's queued, same as the server will.
  const round = mine.rewatch;
  const inRound = round ? (queuedState ? queuedState === "watched" : round.watchedThisRound) : false;

  const act =
    (fn: () => Promise<any>, queuedAs?: "watched" | "unwatched", opts?: { logsPlay?: boolean }) => async () => {
      setBusy(true);
      // The receipt goes up BEFORE the request, not after two sequential round
      // trips (POST, then a full page refetch). It used to take ~360ms on
      // localhost — a second or more on a phone — with the only feedback two
      // buttons dimming to 0.55, while the removal half of the same list
      // dropped its row in 167ms.
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
          // the receipt, and it already carries the date, a green "just now"
          // tag and a bumped header count. A fourth notice for one tap is the
          // personality standing in the tap path. (The block announces the
          // change to screen readers from its own live region.) The offline
          // case keeps its toast — there is no server row to point at.
          if (r?.roundComplete) toast(`Round ${r.round} in the books.`);
        }
        // The watch endpoint flags when this mark just finished the show.
        // Only the mark-watched post carries it, so undo/rating never fire.
        if (r?.caughtUp) celebrate(r.showTitle ?? ep.showTitle);
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

  const logPlay = act(() => post(`/episodes/${ep.id}/watch`), "watched", { logsPlay: true });

  // Un-ticking is two different actions wearing one button, and only one of
  // them is destructive:
  //   - mid-round, in the round → the server drops just THIS round's play and
  //     keeps the row; the page falls back to "watched before". Reversible in
  //     one tap, same as the show page's checkbox, so no dialog.
  //   - otherwise → the row and EVERY dated play with it. That is the whole
  //     history the feature promises never to destroy, so it asks first and
  //     says how many plays are on the line.
  const undo = async () => {
    // 'round': this round's play and nothing else — the scope travels in the
    // request so a replay out of the offline queue can't be re-read as the
    // purge below (see api.ts's del).
    if (inRound) return act(() => del(`/episodes/${ep.id}/watch`, { scope: "round" }), "unwatched")();
    const total = Math.max(mine.playCount, mine.playsTotal ?? mine.plays?.length ?? 0, 1);
    const only = mine.plays?.[mine.plays.length - 1]?.watchedAt ?? mine.watchedAt;
    const ok = await confirm({
      title: "Unwatch this episode?",
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
          <>The episode goes back to unwatched.</>
        ),
      confirmLabel: "Unwatch",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (!ok) return;
    await act(() => del(`/episodes/${ep.id}/watch`, { scope: "all" }), "unwatched")();
    // The history block vanishes with the watched state, so the receipt (and
    // the screen-reader announcement — the toast is a live region) comes from
    // outside it.
    toast(total > 1 ? `Back to unwatched. ${total} plays removed.` : "Back to unwatched.");
    setFocusMark(true);
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
            {/* The round chip rides with the production metadata, not with
                the buttons. In the action row it sat 12px from the solid
                amber "Mark for round 2" primary — the only two amber objects
                on the page, adjacent, one of them not interactive — and in
                the watched-in-round state it read as a third button that did
                nothing. Here it is one slate beside another, same family as
                S01·E01, and it goes somewhere: the show, where the round
                lives — and the show title link at the top of the page already
                goes there, so it stays a mark, not a second route. */}
            {round && (
              // No `title`: the show page states the rule this feature keeps
              // — a tooltip never fires on touch, which is where this product
              // lives — so the sentence a mouse used to get lives in the
              // accessible name instead, and the chip itself is the sighted
              // version of it.
              <span className="rewatch-chip">
                <span className="rewatch-glyph" aria-hidden="true">
                  <IconRewatch size={12} />
                </span>
                <span className="sr-only">Rewatch </span>
                ROUND {round.round}
              </span>
            )}
          </div>
          <h1>{ep.title ?? `Episode ${ep.number}`}</h1>
          {ep.overview && <p className="episode-overview">{ep.overview}</p>}

          <div className="episode-actions">
            {watched && (!round || inRound) ? (
              <>
                {/* Mid-round this button is round-scoped and says so — it used
                    to read "Watched ✓ (undo)" in both states, take one play
                    off, change nothing else on the page, and then destroy the
                    whole history on the second tap. It says "this round", not
                    "round 2": the chip in the slate row above already names
                    the number, and printing it twice in 300px made the page
                    look like it was tracking two different things. */}
                <button className="btn btn-ghost" onClick={undo} disabled={busy}>
                  {inRound ? (
                    <>
                      <span className="rewatch-glyph" aria-hidden="true">
                        <IconRewatch size={13} />
                      </span>{" "}
                      Watched this round (undo)
                    </>
                  ) : (
                    "Watched ✓ (undo)"
                  )}
                </button>
                {/* One label per scope, and this one is the small scope: ONE
                    play of ONE episode, dated now. It used to read
                    "+ Watch again" inside a round and "+ Rewatch" outside one
                    — three labels for two actions across the feature, with
                    the collision falling on "Watch again", which on the show
                    page opens a whole 78-episode round. "Log a play" is the
                    same noun the history list right below it counts in, and
                    it can't be mistaken for the big one.
                    The round context is in the accessible name rather than a
                    `title`, which never fires on touch. */}
                <button className="btn btn-ghost" onClick={logPlay} disabled={busy}>
                  + Log a play
                  <span className="sr-only">
                    {inRound ? ` — another one, inside round ${round!.round}` : " — another one, dated now"}
                  </span>
                </button>
              </>
            ) : (
              <button className="btn" ref={markRef} onClick={logPlay} disabled={busy}>
                <IconCheck size={16} /> {watched && round ? `Mark for round ${round.round}` : "Mark watched"}
              </button>
            )}
          </div>
          {/* The state the old page had no words for: seen before, not yet in
              this round. Without it "Mark watched" looks like the page forgot
              the three plays listed right underneath it. Body face, not mono —
              it is a sentence, and mono is for what's printed on the tape
              (DESIGN.md §3). */}
          {watched && round && !inRound && <p className="episode-round-note">Watched before, but not in this round yet.</p>}
          {/* Dated per-play history in place of the old one-line note. A
              "+ Rewatch" tap lands a new row at the top of it immediately —
              that appearing row is the receipt for the tap. */}
          {watched && (
            <WatchHistory
              kind="episode"
              id={ep.id}
              plays={mine.plays ?? []}
              playCount={mine.playCount}
              playsTotal={mine.playsTotal}
              tz={tz}
              busy={busy}
              act={act}
              rounds={mine.rewatchRounds}
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
