// Watch history — the dated, per-play record behind a watched episode or
// movie (migration 0043: user_episode_plays / user_movie_plays).
//
// The old UI printed one line, "Watched Jan 3 · 3 plays", which is the exact
// dead end TV Time left our users in: a counter with no dates and no way to
// take back a single mistaken tap without unwatching the whole thing. This
// block is the honest version — every play the server has a date for, newest
// first, each one individually removable.
//
// Rules it exists to keep:
//   - History is never destroyed as a side effect, and never becomes
//     unreachable either. The payload ships the newest 25 plays; the rest are
//     one "Load older plays" tap away (GET /{kind}s/:id/plays?before=…), the
//     way Letterboxd pages the diary and Trakt pages the play list. A count
//     you cannot open is not a history.
//   - A removal is reversible. Taking one play off a longer log needs no
//     dialog: the row goes instantly and leaves an Undo in its place, which
//     re-POSTs the exact same timestamp and puts the row back. Only the
//     removal that empties the log — a real unwatch — still asks first,
//     because that one unmounts the block and takes the watched state with it.
//   - A tap always leaves a row. Logging is optimistic in BOTH directions:
//     the provisional row goes up before the request is sent (online or
//     queued offline), same as a removal drops its row before the DELETE
//     resolves. Two halves of one list cannot have two different physics.
//   - Counts stay honest, and each kind of gap is named for what it is.
//     Legacy rows can owe plays the old schema never dated (only the first
//     watch and the last rewatch had timestamps): that gap is a FOOTNOTE
//     under the list, printed date-neutrally, because those plays fall
//     BETWEEN the dates above — which is exactly why it cannot sit in the
//     oldest slot of a descending list.
//   - Which viewing a play belonged to survives the round ending. Rounds are
//     dated sessions, so a play is tagged from the round whose window it
//     falls in, open or long closed (Trakt and Simkl both keep session
//     attribution on historic plays).
//   - The dominant case stays small. 13,805 of this account's episodes have
//     exactly one play: for them the whole block collapses to one quiet mono
//     line — date and × in one press target — and only a real log (2+ plays,
//     or undated ones to reconcile) earns the titled, ruled table.
//
// Shared by episode.tsx and movie.tsx: the movie case is the Letterboxd one —
// no rounds, just dated plays — and it is the same list.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "./dialog";
import { useToast } from "./toast";
import { api, post } from "../api";
import { fmtAgo, fmtDateTime, todayStr } from "../format";
import { IconClose, IconChevron, IconRewatch } from "./icons";

export interface Play {
  watchedAt: string;
}

// One rewatch run of the show, as the episode payload ships it. `finishedAt`
// is null on the open one; a play belongs to the round whose window contains
// its timestamp (>= the start, never > — the equality bug Trakt shipped for
// years silently dropped plays stamped at exactly the boundary).
export interface Round {
  round: number;
  startedAt: string;
  finishedAt?: string | null;
}

// A play the user has logged that the server hasn't confirmed yet — the
// receipt for the tap, standing in until the refetch lands. `queued` means it
// went to the offline queue rather than straight down the wire.
//
// `base` is the playCount at tap time, and it is what retires the row: the
// first payload whose count has grown past it is the one carrying the real
// play. NOT a timestamp match, which fails in three directions —
// reload() repaints the STALE cached payload before the network answers, a
// clock-skewed client never matches the server's own stamp, and a fuzzy
// "within 60s" match (what the queued rows used) silently claims the WRONG
// play if you log twice inside a minute, so the second tap leaves no row at
// all. A count is a count.
export interface PendingPlay {
  ts: string;
  base: number;
  queued?: boolean;
}

// A comfort show gets rewatched a lot, and a twenty-row log would shove the
// rating and the comments off the screen. Show a season's worth of recent
// plays and keep the rest one tap away.
const COLLAPSED = 6;

// One "Load older plays" page, matching the server's PLAYS_PAGE.
const PAGE = 25;

// How long a just-logged play wears its "just now" tag and its settling
// highlight. Long enough that a thumb-tap's receipt is still on screen when
// the eye gets there (the 0.22s slide-in is over before that), short enough
// that it never becomes decoration.
const FRESH_MS = 120_000;

// How long the Undo a removal leaves behind stays on offer. The same window
// as "just now", for the same reason: it covers the mis-tap you notice a
// moment later, and it is gone before it can become furniture.
const UNDO_MS = 120_000;

// Focus-target sentinels: the block's own heading (for when the row that had
// focus was the last one in the list), and the Undo that replaces a row.
const HEAD = " head";
const UNDO = " undo";

// The oldest play is the first watch; everything above it is a rerun.
interface RowSpec {
  ts: string;
  queued?: boolean; // logged offline, not yet on the server
  saving?: boolean; // logged online, POST still in flight
}

export function WatchHistory({
  kind,
  id,
  plays,
  playCount,
  playsTotal,
  tz,
  busy,
  act,
  rounds,
  pending,
  onUnwatched,
}: {
  kind: "episode" | "movie";
  id: number;
  plays: Play[];
  playCount: number;
  // How many dated plays the server holds, when it holds more than it sent
  // (the payload caps the list — see PLAYS_LIMIT in routes/catalog.ts).
  // Absent on a payload cached before the cap existed, where the list IS the
  // whole history.
  playsTotal?: number;
  tz: string;
  busy: boolean;
  // The page's own act() wrapper, so a removal shares its busy flag and its
  // post-change reload with every other control on the page.
  act: (fn: () => Promise<any>) => () => Promise<void>;
  // Every rewatch round the show has had (episode pages only), oldest first.
  // Plays are tagged from the round whose window they fall in — including
  // rounds that closed months ago, which is the difference between a log that
  // says which rerun this was and one that forgets the moment a round ends.
  rounds?: Round[];
  // Plays the server hasn't confirmed yet — queued offline, or a POST still
  // in flight. Either way the tap gets its row immediately.
  pending?: PendingPlay[];
  // The last dated play just came off, which is a full unwatch — the page
  // drops its watched state locally instead of waiting for the refetch.
  onUnwatched?: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  // Rows removed locally, ahead of the refetch. A DELETE that succeeds
  // followed by a slow (or failed) GET used to leave the removed play on
  // screen and the header count wrong, with no spinner and no error — the
  // list is the receipt, so it drops the row on success and lets the refetch
  // confirm. Entries are PRUNED, never reset: one leaves only once server
  // data arrives that no longer contains it.
  const [removed, setRemoved] = useState<string[]>([]);
  // Older pages pulled in by "Load older plays", and plays put back by Undo —
  // both live locally until a refetch carries them, so neither the paging nor
  // the undo has a dead frame where the list is wrong.
  const [older, setOlder] = useState<Play[]>([]);
  const [restored, setRestored] = useState<Play[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // The server says there is nothing older, whatever `playsTotal` still
  // claims. playsTotal is a snapshot from page load; a play removed in another
  // tab makes it one too many, and without this the pager would sit there
  // forever offering a page that can never arrive.
  const [noMore, setNoMore] = useState(false);
  // The one removal still on offer to undo, and when the offer lapses.
  const [undo, setUndo] = useState<{ ts: string; until: number } | null>(null);
  const [status, setStatus] = useState(""); // polite live region
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [, retick] = useState(0); // "just now" / Undo expiry
  const headRef = useRef<HTMLHeadingElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const btns = useRef(new Map<string, HTMLButtonElement | null>());

  const pend = pending ?? [];

  // Every dated play on screen: the payload's page, the older pages fetched
  // since, and anything an Undo put back — deduped and re-sorted, because a
  // restored play belongs back at ITS date, not on the end.
  const loaded = useMemo(() => {
    const seen = new Set<string>();
    const out: Play[] = [];
    for (const p of [...plays, ...older, ...restored]) {
      if (seen.has(p.watchedAt)) continue;
      seen.add(p.watchedAt);
      out.push(p);
    }
    out.sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : a.watchedAt > b.watchedAt ? -1 : 0));
    return out;
  }, [plays, older, restored]);

  // A provisional row retires the instant its real one is on screen — decided
  // HERE, in render, not only in the page's post-fetch effect. React commits
  // the payload one render before that effect prunes the array, and for that
  // one frame the row and its server twin were both counted: the header
  // flashed "5 plays" on a title with four, and the live region announced the
  // flash.
  const provisional: RowSpec[] = pend
    .filter((p) => playCount <= p.base)
    .map((p) => ({ ts: p.ts, queued: p.queued, saving: !p.queued }));
  // Removals still waiting on the refetch. A `removed` entry whose play has
  // ALREADY left the payload is spent, and subtracting it from the server's
  // own numbers a second time deflates the count for the one render before
  // the prune effect below runs. That dip then "grew" back on the next
  // render, and the announcer read the recovery as a NEW play — a removal
  // ended with the live region saying "Logged. 2 plays."
  const pendingRemoved = removed.length ? removed.filter((ts) => loaded.some((p) => p.watchedAt === ts)) : removed;
  const dated = pendingRemoved.length ? loaded.filter((p) => !pendingRemoved.includes(p.watchedAt)) : loaded;
  // Every dated play the server has, which is not always every one on screen:
  // the payload ships the newest 25 and the rest arrive a page at a time.
  const totalDated = Math.max(playsTotal ?? loaded.length, loaded.length);
  // Dated plays that exist but haven't been fetched yet. Counted separately
  // from the undated ones below — these HAVE dates, we just don't hold them,
  // and saying "no date on record" about them would be a lie.
  const unfetched = Math.max(0, totalDated - loaded.length);
  // Plays the count knows about but has no date for (pre-0043 middle plays).
  // Computed from the server's own numbers, so a local removal — which drops
  // a dated play AND the count together — never invents an undated one.
  const undated = Math.max(0, playCount - totalDated);
  // The headline count is the larger of the two truths: the denormalized
  // play_count and the dated plays actually on record.
  const count = Math.max(0, Math.max(playCount, totalDated) - pendingRemoved.length) + provisional.length;

  useEffect(() => {
    setRemoved((r) => {
      const next = r.filter((ts) => loaded.some((p) => p.watchedAt === ts));
      return next.length === r.length ? r : next;
    });
  }, [loaded]);

  // The sighted receipt for a "+ Rewatch" tap is the row that appears; this
  // is the same receipt for a screen reader, and the reason the page no
  // longer fires a toast for it. Announces only on a GROWING count, so the
  // refetch that merely swaps a provisional row for the real one is silent.
  const announced = useRef<number | null>(null);
  const skipAnnounce = useRef(false); // an Undo grows the count too, and says so itself
  useEffect(() => {
    if (announced.current !== null && count > announced.current && !skipAnnounce.current) {
      setStatus(`Logged. ${count} play${count === 1 ? "" : "s"}.`);
    }
    skipAnnounce.current = false;
    announced.current = count;
  }, [count]);

  // A restored play stops being local the moment the server's own copy of it
  // arrives (in the page payload, or in a page of older plays).
  useEffect(() => {
    setRestored((rs) => {
      if (!rs.length) return rs;
      const has = (ts: string) => plays.some((p) => p.watchedAt === ts) || older.some((p) => p.watchedAt === ts);
      const next = rs.filter((r) => !has(r.watchedAt));
      return next.length === rs.length ? rs : next;
    });
  }, [plays, older]);

  // Re-render once the newest play stops being new, and once the Undo window
  // closes, so both expire on their own rather than lingering until something
  // else touches the page.
  useEffect(() => {
    const now = Date.now();
    const deadlines = [plays[0] ? Date.parse(plays[0].watchedAt) + FRESH_MS : NaN, undo ? undo.until : NaN].filter(
      (d) => !Number.isNaN(d) && d > now
    );
    if (!deadlines.length) return;
    const t = window.setTimeout(() => retick((n) => n + 1), Math.min(...deadlines) - now + 50);
    return () => window.clearTimeout(t);
  }, [plays, undo]);

  // Focus follows the removal. Two things fight it, so this waits for both:
  // every × is disabled while the request is in flight (a disabled button
  // can't take focus), and the confirm <dialog> hands focus back to whatever
  // opened it — the row that just disappeared — in a task of its own after
  // `close`, which drops the caret on <body>.
  useEffect(() => {
    if (!focusKey || busy) return;
    const el =
      focusKey === HEAD ? headRef.current : focusKey === UNDO ? undoRef.current : btns.current.get(focusKey);
    el?.focus();
    const t = window.setTimeout(() => {
      el?.focus();
      setFocusKey(null);
    }, 80);
    return () => window.clearTimeout(t);
  }, [focusKey, busy]);

  // Two fixed-width mono columns instead of one ragged string: the day is
  // zero-padded and the hour is too, so "Aug 02, 2018" and "Dec 29, 2025"
  // occupy the same 12 characters and every time in the list ends on the same
  // pixel. A mono log that doesn't line up wastes the only thing mono buys.
  const fmt = useMemo(
    () => ({
      date: new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "2-digit", year: "numeric" }),
      time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }),
      day: new Intl.DateTimeFormat("en-CA", { timeZone: tz }), // YYYY-MM-DD, for Today/Yesterday
    }),
    [tz]
  );
  const today = todayStr(tz);
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
  const dayLabel = (ts: string) => {
    const d = new Date(ts);
    const key = fmt.day.format(d);
    return key === today ? "Today" : key === yesterday ? "Yesterday" : fmt.date.format(d);
  };
  const timeLabel = (ts: string) => fmt.time.format(new Date(ts));

  // Nothing on record at all — bail rather than render an empty block under a
  // button that reads "Watched ✓".
  if (dated.length === 0 && undated === 0 && unfetched === 0 && provisional.length === 0) return null;

  const isFresh = (ts: string) => Date.now() - Date.parse(ts) < FRESH_MS;
  // Which round a play belongs to: the one whose dated window contains it.
  const roundOf = (ts: string) => {
    const t = Date.parse(ts);
    return (rounds ?? []).find(
      (r) => t >= Date.parse(r.startedAt) && (!r.finishedAt || t <= Date.parse(r.finishedAt))
    );
  };

  // Put a removed play back with its ORIGINAL timestamp — the plays table is
  // keyed on (user, title, watched_at), so re-POSTing that exact date restores
  // the exact row, in its exact place in the log. The row reappears now; the
  // refetch only confirms it.
  const restorePlay = (watchedAt: string) => async () => {
    skipAnnounce.current = true; // this one announces itself, below
    setUndo(null);
    setRestored((rs) => (rs.some((r) => r.watchedAt === watchedAt) ? rs : [...rs, { watchedAt }]));
    setRemoved((r) => r.filter((ts) => ts !== watchedAt));
    setStatus(`Play from ${fmtDateTime(watchedAt, tz)} restored.`);
    setFocusKey(watchedAt);
    try {
      await act(() => post(`/${kind}s/${id}/watch`, { watched_at: watchedAt }))();
    } catch {
      setRestored((rs) => rs.filter((r) => r.watchedAt !== watchedAt));
      setStatus("");
      toast("Couldn’t put that play back", "error");
    }
  };

  const remove = (watchedAt: string) => async () => {
    // Removing the only dated play sends the title back to unwatched (the
    // server drops the row once no play remains). That one unmounts this whole
    // block, Undo and all, so it is the one that still asks first. Every other
    // removal is one row off a log that stays on screen with an Undo where the
    // row was — Letterboxd-grade friction, no dialog in the way.
    const onlyDated = dated.length === 1;
    if (onlyDated) {
      // The dialog covers the row that was tapped, so it names the date rather
      // than saying "this one" over the thing it's hiding — in mono, matching
      // the row (DESIGN.md §3, Printed-On-The-Tape).
      const when = <strong>{fmtDateTime(watchedAt, tz)}</strong>;
      const ok = await confirm({
        title: undated ? "Remove your only dated play?" : `Unwatch this ${kind}?`,
        message: undated ? (
          <>
            {when} is the only dated play left, so the {kind} goes back to unwatched, and the{" "}
            <strong>
              {undated} undated play{undated === 1 ? "" : "s"}
            </strong>{" "}
            go with it.
          </>
        ) : (
          <>{when} is your only play, so the {kind} goes back to unwatched.</>
        ),
        confirmLabel: undated ? "Remove play" : "Unwatch",
        cancelLabel: "Keep it",
        danger: true,
      });
      if (!ok) return;
    } else {
      // The row goes NOW, not when the refetch lands — Letterboxd and Trakt
      // both drop it instantly and reconcile after. Focus lands on the Undo
      // that takes its place, so a keyboard user isn't dumped at the top of
      // the document by the row disappearing under them.
      setRemoved((r) => [...r, watchedAt]);
      setUndo({ ts: watchedAt, until: Date.now() + UNDO_MS });
      const left = count - 1;
      setStatus(`Play removed. ${left} play${left === 1 ? "" : "s"} left. Undo to put it back.`);
      setFocusKey(UNDO);
    }
    try {
      await act(() =>
        api(`/${kind}s/${id}/plays`, { method: "DELETE", body: JSON.stringify({ watched_at: watchedAt }) })
      )();
    } catch {
      // Online-only endpoint (it isn't in the offline queue's allowlist), so
      // a dropped connection lands here rather than silently doing nothing.
      // Put the row back: the history on screen is always the history the
      // server has.
      setRemoved((r) => r.filter((ts) => ts !== watchedAt));
      setUndo(null);
      setStatus("");
      setFocusKey(watchedAt); // back on the row that didn't go anywhere
      toast("Couldn’t remove that play", "error");
      return;
    }
    if (onlyDated) {
      setRemoved((r) => [...r, watchedAt]);
      // This block is about to unmount with its live region, so the toast —
      // role="status" and outside the block — carries the announcement.
      toast(`Play removed. This ${kind} is back to unwatched.`);
      onUnwatched?.(); // the page takes focus from here
    }
  };

  // One page of older plays, cursored on the oldest row already held. Plays
  // are append-only and this pages BACKWARDS, so a play logged mid-scroll
  // lands above the cursor and can't shift the window under it (which an
  // OFFSET would, duplicating or skipping a row).
  const loadOlder = async () => {
    const cursor = loaded[loaded.length - 1]?.watchedAt ?? new Date().toISOString();
    setLoadingOlder(true);
    setLoadError(false);
    try {
      const r = await api<{ plays: Play[] }>(`/${kind}s/${id}/plays?before=${encodeURIComponent(cursor)}`);
      const got = r.plays ?? [];
      setOlder((o) => {
        const seen = new Set(o.map((p) => p.watchedAt));
        return [...o, ...got.filter((p) => !seen.has(p.watchedAt))];
      });
      if (!got.length) setNoMore(true);
      setExpanded(true); // they asked for more history; don't hide it behind a second tap
      setStatus(got.length ? `${got.length} older play${got.length === 1 ? "" : "s"} loaded.` : "No older plays left.");
    } catch {
      setLoadError(true);
      setStatus("Couldn’t load older plays.");
    } finally {
      setLoadingOlder(false);
    }
  };

  // The live region is mounted for the life of the block (an element that
  // appears WITH its text is unreliably announced), and stays sr-only: the
  // list itself is the sighted receipt.
  const live = (
    <p className="sr-only" role="status" aria-live="polite">
      {status}
    </p>
  );

  const removeBtn = (ts: string, label: string) => (
    <button
      type="button"
      className="icon-btn play-remove"
      ref={(el) => {
        if (el) btns.current.set(ts, el);
        else btns.current.delete(ts);
      }}
      disabled={busy}
      aria-label={label}
      title={label}
      onClick={remove(ts)}
    >
      <IconClose size={15} />
    </button>
  );

  // The removal still on offer, if its window hasn't lapsed. Computed HERE,
  // above the single-play collapse, because the collapse has to know about it:
  // an Undo is a row in the list, and the collapsed form has no list.
  const undoLive = undo && undo.until > Date.now() ? undo : null;

  // ---- The dominant state: one play, nothing to reconcile ----
  // A section heading, a rule, a table and a destructive × is ~107px of
  // furniture around a single date. One quiet mono line says the same thing in
  // a third of the space — with the × immediately AFTER the date, inside a
  // single row-height press target, instead of flung to the far right of an
  // invisible row where 175px of nothing separated the glyph from the date it
  // removes and no fill or rule tied them together.
  //
  // NOT while an Undo is live. Taking a log from two plays to one satisfies
  // every clause below, so the block used to collapse the instant the row
  // dropped — swallowing the Undo that replaced it, in the one case where a
  // user is most likely to want it (undoing the single rewatch play they just
  // mis-logged) — while the live region had already told a screen-reader user
  // to press it. The collapse can wait the 120s out; the list holds the Undo
  // in the row's own place until then.
  if (!undoLive && count === 1 && dated.length === 1 && undated === 0 && unfetched === 0 && provisional.length === 0) {
    const ts = dated[0].watchedAt;
    const full = fmtDateTime(ts, tz);
    const sameDay = fmt.day.format(new Date(ts)) === today;
    return (
      <div className={`watch-history is-single${isFresh(ts) ? " is-fresh" : ""}`}>
        <h2 className="sr-only">Watch history</h2>
        <span className="mono watch-single" title={`${full} · ${fmtAgo(ts)}`}>
          Watched {dayLabel(ts)}
          {sameDay && `, ${timeLabel(ts)}`}
        </span>
        {removeBtn(ts, `Unwatch — removes the play from ${full}`)}
        {live}
      </div>
    );
  }

  const rows: RowSpec[] = [...provisional, ...dated.map((p) => ({ ts: p.watchedAt }))];
  const shown = expanded ? rows : rows.slice(0, COLLAPSED);
  // The bottom of the FULL list is the first watch (0043's backfill dated it,
  // whatever else the old schema lost) — labelled whenever there's something
  // above it to tell it apart from, undated plays included. A live Undo
  // counts as something above it: the one-row list only reaches this render at
  // all because a removal left an Undo in the list, and without this the sole
  // survivor — the first watch — wore the ↻ that means "this one is a rerun
  // of the rows below", with no rows below.
  const firstWatchTs =
    unfetched > 0 ? null : rows.length > 1 || undated > 0 || undoLive ? rows[rows.length - 1].ts : null;
  // There is more dated history on the server than the page holds, and the
  // server hasn't said otherwise.
  const pageable = unfetched > 0 && !noMore;
  // The Undo sits where the row was, in date order. An undo that jumps to a
  // corner of the screen is an undo you have to go looking for.
  const undoAt = undoLive ? shown.filter((r) => Date.parse(r.ts) > Date.parse(undoLive.ts)).length : -1;

  const undoRow = undoLive ? (
    <li className="play-row play-undone">
      <span className="play-mark" aria-hidden="true" />
      <span className="play-undone-text">
        Removed <span className="mono">{dayLabel(undoLive.ts)}</span>
      </span>
      <button
        type="button"
        className="link-btn play-undo"
        ref={undoRef}
        disabled={busy}
        onClick={restorePlay(undoLive.ts)}
      >
        Undo
      </button>
    </li>
  ) : null;

  return (
    <section className="watch-history" aria-labelledby={`wh-${kind}-${id}`}>
      <div className="watch-history-head">
        <h2 className="watch-history-label" id={`wh-${kind}-${id}`} ref={headRef} tabIndex={-1}>
          Watch history
        </h2>
        {count > 1 && <span className="mono watch-history-count">{count} plays</span>}
      </div>
      <ul className="play-list">
        {shown.map((r, i) => {
          const inFlight = !!(r.queued || r.saving);
          const first = r.ts === firstWatchTs;
          const fresh = !inFlight && isFresh(r.ts);
          const rnd = inFlight ? undefined : roundOf(r.ts);
          // One tag slot, most-newsworthy wins: the receipt for the tap you
          // just made, then the sync state, then which viewing this was.
          const tag = r.queued
            ? "queued"
            : r.saving
              ? "saving"
              : fresh
                ? "just now"
                : rnd
                  ? `round ${rnd.round}`
                  : first
                    ? "first watch"
                    : null;
          const full = fmtDateTime(r.ts, tz);
          return (
            <Fragment key={r.ts}>
              {i === undoAt && undoRow}
              <li
                className={`play-row${fresh ? " is-fresh" : ""}${r.queued ? " is-queued" : ""}${
                  r.saving ? " is-saving" : ""
                }`}
              >
                {/* Every row below the oldest IS a rewatch — the feature's own
                    glyph says so. Drawn, not typed: the "↻" text character at
                    12px renders as a ~5×6px blob that reads as a comma, and
                    the same feature already ships the icon (icons.tsx) for the
                    badges over artwork. A word rides behind it for screen
                    readers, so the shape is never the only signal. */}
                <span className="play-mark">
                  {!first && (
                    <>
                      <IconRewatch size={13} />
                      <span className="sr-only">Rewatch</span>
                    </>
                  )}
                </span>
                {/* Absolute in the column, relative on hover — Trakt's play
                    list prints both; a fixed 12ch column can only hold one. */}
                <span
                  className="mono play-date"
                  title={r.queued ? "Waiting to sync" : r.saving ? "Saving…" : fmtAgo(r.ts)}
                >
                  {dayLabel(r.ts)}
                </span>
                <span className="mono play-time">{timeLabel(r.ts)}</span>
                {tag && <span className={`mono play-tag${fresh ? " is-fresh" : ""}`}>{tag}</span>}
                {inFlight ? (
                  // Nothing to remove yet: the play is queued offline, or its
                  // POST is still in flight. The spacer holds the column so
                  // the row doesn't jump when the real × arrives.
                  <span className="play-remove-spacer" aria-hidden="true" />
                ) : (
                  removeBtn(r.ts, `Remove the play from ${full}`)
                )}
              </li>
            </Fragment>
          );
        })}
        {undoAt >= shown.length && undoRow}
      </ul>
      {/* Both controls live OUTSIDE <ul class="play-list">: neither is a play.
          They also used to be indistinguishable from the static count lines
          they sat between — three muted grey strings in a row, one of them
          secretly tappable. Now the tappable ones are the only things down
          here, they carry a chevron, and they are set in text, not muted. */}
      {(rows.length > COLLAPSED || pageable) && (
        <div className="play-foot">
          {rows.length > COLLAPSED && (
            <button
              type="button"
              className="link-btn play-expand"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              <span className={`play-chevron${expanded ? " is-open" : ""}`} aria-hidden="true">
                <IconChevron size={14} />
              </span>
              {/* "N more", not "all N plays" — the heading already prints the
                  lifetime count, and the two numbers differ whenever a legacy
                  row owes undated plays. */}
              {expanded ? "Show fewer" : `Show ${rows.length - COLLAPSED} more`}
            </button>
          )}
          {pageable && (
            // Dated plays the payload didn't carry. They HAVE dates — they're
            // just not here yet. This was a dead-end string ("+ 7 older plays
            // on record") with nothing to tap, no link and no route, which
            // made the feature's headline promise unverifiable by the person
            // it was made to.
            <button
              type="button"
              className="link-btn play-load"
              onClick={loadOlder}
              disabled={loadingOlder || busy}
              aria-label={`Load older plays — ${unfetched} more on record`}
            >
              <span className="play-chevron" aria-hidden="true">
                <IconChevron size={14} />
              </span>
              {loadingOlder
                ? "Loading…"
                : `Load ${Math.min(unfetched, PAGE)} older play${Math.min(unfetched, PAGE) === 1 ? "" : "s"}`}
            </button>
          )}
          {loadError && <span className="play-foot-error">Couldn’t reach those. Try again?</span>}
        </div>
      )}
      {undated > 0 && (
        // A FOOTNOTE under the list's last rule — not the bottom <li> of a
        // descending list, where every reader takes the last entry for the
        // oldest. These are pre-0043 middle plays: the old schema dated only
        // the first watch and the last rewatch, so they fall BETWEEN the rows
        // above, never before them. The count is mono because it's a count;
        // the sentence is not, because prose is never mono (DESIGN.md §3).
        <p className="watch-history-note">
          <span className="mono">{undated}</span> more play{undated === 1 ? "" : "s"} in your count{" "}
          {undated === 1 ? "was" : "were"} logged before showustv dated every play, somewhere among the dates above.
        </p>
      )}
      {live}
    </section>
  );
}
