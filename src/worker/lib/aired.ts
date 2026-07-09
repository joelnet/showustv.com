// The single definition of "this episode has aired". TMDB is missing air
// dates for plenty of episodes that ran decades ago (issue: HBO's Real Sex has
// 15 undated episodes), and a bare `air_date <= today` misclassifies those as
// unaired — blocking the watched toggle and shrinking progress denominators.
//
// An episode counts as aired when:
//   - its air date is known and has passed, OR
//   - its date is unknown but it can't plausibly be upcoming:
//       - the show is Ended/Canceled (nothing is upcoming), or
//       - a later regular-season episode has already aired (a mid-run gap).
// Undated episodes that fail both tests — e.g. announced-but-unscheduled
// stubs on a continuing show — stay "not aired".
//
// Derived at query time rather than stored: air dates and show status change
// on every TMDB sync, and "today" moves on its own.

// SQL fragment of the rule for an episodes row aliased `e`. `todayParam` is a
// bound 'YYYY-MM-DD' placeholder (e.g. "?2"); `showsAlias` names a joined
// shows table for the status check.
export function airedCond(todayParam: string, showsAlias: string): string {
  return `((e.air_date IS NOT NULL AND e.air_date <= ${todayParam}) OR (e.air_date IS NULL AND (${showsAlias}.status IN ('Ended','Canceled') OR EXISTS (
    SELECT 1 FROM episodes later
    WHERE later.show_id = e.show_id AND later.season_number > 0 AND later.air_date <= ${todayParam}
      AND (later.season_number > e.season_number OR (later.season_number = e.season_number AND later.number > e.number))
  ))))`;
}
