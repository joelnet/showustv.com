// The rewatch vocabulary (0043), in one place, because the numbers involved
// are easy to confuse and three endpoints have to agree on them.
//
// Two counts exist for every show, and they must never trade names:
//   - LIFETIME progress — distinct aired regular-season episodes the user has
//     ever watched. It is what `progress.watched` on GET /shows/:id and
//     `watched` on a GET /library row have always meant, and a rewatch never
//     changes either of them.
//   - ROUND progress — of those same aired regular-season episodes, the ones
//     with a play stamped on/after the open round's `startedAt`. It lives
//     ONLY inside a `rewatch` object, under `roundWatched`, on every endpoint
//     that reports it. No endpoint ever swaps it into a key named `watched`.
//
// Every `rewatch` object in the API is one of these, so a client that learns
// the shape once can read it anywhere:
//   - GET /shows/:id       user.rewatch      { round, startedAt, roundWatched }
//   - GET /library row     rewatch           { round, startedAt, roundWatched }
//   - GET /episodes/:id    user.rewatch      { round, startedAt, watchedThisRound }
//   - /home tiles          rewatch           { round, startedAt }
//     ...and on a History tile, { round } alone: that one names the round a
//     PAST play landed in (it may be long closed), not an open session, so
//     the session fields would be a lie rather than an omission.
//
// `rounds` (a plain number, completed rounds, 0 when none) is likewise always
// spelled the same and always present on the surfaces that report it —
// omitting it at 0 would make "no rounds" and "old client" indistinguishable.
//
// GET /shows/:id additionally carries `lastRound: { round, finishedAt } |
// null`. That is the one deliberate asymmetry in here, and it is a detail-view
// field by design: the show page prints "watched ×2 · round 2 done Mar 14",
// because a completed rerun that leaves only a counter behind is the TV Time
// ×2 badge again — the thing this feature exists to beat. A poster grid has
// nowhere to put a date, so the Library row doesn't carry one.
export interface RewatchRef {
  // The round number. Round 2 is the first rewatch — the original watch is
  // implicitly round 1 — so times-through = rounds + 1.
  round: number;
  // When the round opened (UTC ISO). Absent only on a History tile's
  // attribution tag, where the round being named may already be closed.
  startedAt?: string;
  // Round progress: aired regular-season episodes with a this-round play.
  // Show-level surfaces only.
  roundWatched?: number;
  // Whether THIS episode is in the round. Episode-level surfaces only.
  watchedThisRound?: boolean;
}
