---
title: Watch Now page
purpose: How the home page ("Watch Now") picks, orders, and updates the shows a user should watch. The route, component, and API keep their original "watch next" names in code.
---

## What it is

The home page at `/`. Two tabs under a shared "Watch Now" heading:

1. **Watch Now** — a grid of tiles, one per followed show, each showing the show's next unwatched aired episode. Ordered by most recent activity.
2. **Upcoming** — a grid of tiles (matching the Watch Now style) showing the next episode to air for each followed show, soonest first. One row per show, so a show with several scheduled episodes doesn't crowd out others; click through for its full schedule.

The tab was renamed from "Watch next" to "Watch Now"; the route, component, and API keep their original `watch-next` / `WatchNext` names.

Route registration: `src/web/app.tsx` → `<Route path="/" element={<WatchNext />} />`.
Component: `src/web/pages/watchnext.tsx` (`WatchNext` at :99).
API: `GET /watch-next`, handled in `src/worker/routes/library.ts:53`.

## Data flow

```
WatchNext (watchnext.tsx:99)
  useApi("/watch-next")           ← stale-while-revalidate; refetches after offline sync
    ↓
GET /watch-next                   ← library.ts:53
    Query 1: Watch Now queue      (one row per followed show)
    Query 2: Upcoming episodes    (soonest upcoming per show, aired-after-today)
    ↓
  { watchNext, upcoming }
    ↓
  render Watch Now / Upcoming tabs (both tile grids)
```

## Query 1: Watch Now queue

Source: `library.ts:60–96`. Returns one row per followed show whose next unwatched aired episode should surface.

CTE `cand` picks candidate episodes:

- Show is in `user_shows` with `state = 'watching'`.
- Regular season (`season_number > 0`, no specials).
- `air_date IS NOT NULL AND air_date <= today` (already aired in user's timezone).
- Episode has no matching `user_episodes` row for this user (unwatched).
- `ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY season_number, number)` selects the first unwatched episode per show.
- `COUNT(*) OVER (PARTITION BY show_id)` gives the "N left" badge.

A second CTE `last_aired` gives the most recent aired episode date per show (used for the recency filter).

Outer query joins `shows` + `user_shows` + `last_aired` and computes:

- `last_watched` — MAX(`user_episodes.watched_at`) per show (LEFT JOIN, may be NULL).
- `last_activity` — `CASE WHEN last_watched IS NULL OR last_watched < added_at THEN added_at ELSE last_watched END`. New follows surface immediately; watched shows re-surface on each watch.

Filter:

```sql
WHERE c.rn = 1
  AND (lw.last_watched IS NOT NULL OR us.added_at >= ?3)
  AND (lw.last_watched >= ?3 OR la.air_date >= ?3)
```

- Second clause hides not-yet-started shows unless they were followed within `RECENT_WINDOW_DAYS` (don't let stale follows clutter the queue, but keep new follows visible so they can be started).
- Third clause hides dormant shows — nothing watched recently *and* nothing aired recently. Such shows still show up on the library page under "Haven't watched for a while".

`RECENT_WINDOW_DAYS = 90` — see `src/shared/constants.ts:19`.

Sort: `ORDER BY last_activity DESC, air_date DESC` — most recently active first; ties broken by newest aired episode.

Bound parameters: `?1 = uid`, `?2 = today` (user timezone), `?3 = recentSince` (`today - 90d`).

## Query 2: Upcoming

`episodes` for followed shows with `air_date > today`, deduped to the **soonest upcoming episode per show** via `ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY air_date, season_number, number)` keeping `rn = 1`, ordered by air date, `LIMIT 20` — so the limit applies to distinct shows.

## Frontend behavior

`WatchNext` (`watchnext.tsx:99`):

- Fetches with `useApi` — shows spinner on first load, keeps stale data on reload.
- A tab bar (`tab` state at :107) switches between the **Watch Now** grid (`data.watchNext`) and the **Upcoming** grid (`data.upcoming`, deduped client-side by show as a safety net). Full ARIA tabs pattern with roving `tabindex` + arrow/Home/End keyboard nav; a visually-hidden `<h1>` anchors the page.
- Per-tab empty states: "Nothing on deck" (Watch Now) and "Nothing scheduled" (Upcoming).

`Tile` (`watchnext.tsx:39`) shows poster (with `"N left"` pill overlay), show title, `SxxEyy` slate + episode title, formatted air date, and a "Watched" button. `UpcomingTile` (`:80`) reuses the same shape but leads with the air date and drops the mark/count chrome (nothing has aired yet). `fmtAirDate` (`src/web/format.ts`) renders "Today"/"Tomorrow"/short date in the user's timezone.

## Mark-watched flow

`markWatched` (`watchnext.tsx:114`) → `POST /episodes/:id/watch` (`library.ts:370`).

Server:

- Inserts into `user_episodes` (or bumps `play_count` + `last_rewatched_at` on rewatch).
- Promotes `user_shows.state` from `watch_later` → `watching`.
- Returns `{ ok, caughtUp, showTitle }`. `caughtUp` is true only for a fresh watch of a regular-season episode that leaves zero unwatched aired episodes.

Client:

- If the offline layer queued the request (`r.queued`), adds the episode to a local `hidden` set so the tile disappears immediately; a real refetch happens after the offline queue drains.
- Otherwise calls `reload()` to refetch `/watch-next`.
- If `caughtUp`, calls `useCelebrate()` to trigger the confetti overlay.

The `hidden` set is reset whenever fresh server data arrives (`watchnext.tsx:112`) so it never overrides authoritative state.

## Tables involved

- `user_shows(user_id, show_id, state, added_at, ...)` — state must be `'watching'`; `added_at` powers the recency filter and `last_activity` fallback.
- `user_episodes(user_id, episode_id, watched_at, play_count, last_rewatched_at)` — presence = watched; `MAX(watched_at)` per show drives ranking.
- `episodes(id, show_id, season_number, number, air_date, ...)` — `air_date` is a `YYYY-MM-DD` string compared against `todayInTz(tz)`.
- `shows(tmdb_id, title, poster_url, backdrop_url, ...)` — display metadata.

Schema: `migrations/0001_init.sql`.

## Timezone

All "aired?" and "recent window" comparisons use the user's IANA timezone via `todayInTz` / `daysAgoInTz` (`src/worker/lib/dates.ts`). Air dates are stored as date-only strings, so string comparison against `YYYY-MM-DD` is correct.

## Tuning knobs

- `RECENT_WINDOW_DAYS` (`src/shared/constants.ts:19`) — recency cutoff for both filters: how long a newly followed but never-watched show stays surfaced, and how long dormant shows keep appearing after their last watch/air.
- Upcoming `LIMIT 20` in the second SQL query (one row per show).
- Sort order in the outer query's `ORDER BY`.
