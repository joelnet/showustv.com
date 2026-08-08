import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { ensureShow, ensureMovie } from "../lib/tmdb";
import { nowIso, todayInTz, daysAgoInTz } from "../lib/dates";
import { airedCond } from "../lib/aired";
import { notifyFollowersOfFavorite, notifyFollowersOfWatch } from "../lib/notifications";
// The library payload and its derivation helpers live in lib/library.ts now
// — the public library endpoint shares them, stats.ts-style.
import { libraryPayload, recentlyActive } from "../lib/library";
import { RECENT_WINDOW_DAYS, STORED_SHOW_STATES } from "../../shared/constants";
import type { RewatchRef } from "../../shared/rewatch";

export const library = new Hono<AppEnv>();

function intParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Client may send an explicit watched_at (import, backdating); defaults to now.
function watchedAtFrom(body: any): string | null {
  if (body?.watched_at == null) return nowIso();
  const t = Date.parse(String(body.watched_at));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------- Home: Watch Next ----------

// "From People You Follow" looks back this far for followees'
// episode watches — the same 30-day window the activity feed uses, so the two
// social surfaces agree on what counts as recent.
const FOLLOWING_WINDOW_MS = 30 * 24 * 3600 * 1000;

library.get("/home", async (c) => {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  // Recent window: a show qualifies for the queue if it was watched, had an
  // episode air, or was followed within RECENT_WINDOW_DAYS. Otherwise it's
  // dormant and drops to the "Haven't watched for a while" bucket below.
  const recentSince = daysAgoInTz(c.get("tz"), RECENT_WINDOW_DAYS);
  // Shows mid-rewatch (an active round in user_show_rewatches) re-enter the
  // queue: for them "unwatched" means no this-round play (watched_at >= the
  // round's start) instead of the lifetime watched flag, so the next round
  // episode surfaces like any in-progress show — without touching history.
  const { results } = await c.env.DB.prepare(
    `WITH rw AS (
       SELECT show_id, round, started_at FROM user_show_rewatches
       WHERE user_id = ?1 AND finished_at IS NULL
     ),
     cand AS (
       SELECT e.id, e.show_id, e.season_number, e.number, e.title, e.air_date, e.runtime_min, e.overview, e.still_url,
              r.round AS rewatch_round, r.started_at AS rewatch_started,
              ROW_NUMBER() OVER (PARTITION BY e.show_id ORDER BY e.season_number, e.number) AS rn,
              COUNT(*) OVER (PARTITION BY e.show_id) AS unwatched_aired
       FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       LEFT JOIN rw r ON r.show_id = e.show_id
       WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
         AND e.season_number > 0
         AND ${airedCond("?2", "sh")}
         AND CASE WHEN r.show_id IS NULL
             THEN NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)
             ELSE NOT EXISTS (SELECT 1 FROM user_episode_plays p
                              WHERE p.user_id = ?1 AND p.episode_id = e.id AND p.watched_at >= r.started_at)
             END
     ),
     last_aired AS (
       SELECT show_id, MAX(air_date) AS air_date FROM episodes
       WHERE season_number > 0 AND air_date IS NOT NULL AND air_date <= ?2
       GROUP BY show_id
     )
     SELECT c.id AS episode_id, c.show_id, c.season_number, c.number, c.title AS episode_title,
            c.air_date, c.runtime_min, c.overview, c.still_url, c.unwatched_aired,
            c.rewatch_round, c.rewatch_started,
            s.title AS show_title, s.poster_url, s.backdrop_url,
            us.added_at, lw.last_watched, la.air_date AS last_aired,
            MAX(COALESCE(lw.last_watched, ''), us.added_at, COALESCE(c.rewatch_started, '')) AS last_activity
     FROM cand c
     JOIN shows s ON s.tmdb_id = c.show_id
     JOIN user_shows us ON us.show_id = c.show_id AND us.user_id = ?1
     LEFT JOIN (
       SELECT e2.show_id, MAX(p.watched_at) AS last_watched
       FROM user_episode_plays p JOIN episodes e2 ON e2.id = p.episode_id
       WHERE p.user_id = ?1 GROUP BY e2.show_id
     ) lw ON lw.show_id = c.show_id
     LEFT JOIN last_aired la ON la.show_id = c.show_id
     WHERE c.rn = 1
     ORDER BY last_activity DESC, c.air_date DESC`
  )
    .bind(uid, today)
    .all();

  // Bucket the queue into Continue Watching / Not Started / Haven't Watched
  // in a While by whether the show has been started and is recently active.
  // episodeId names the exact next-up episode the tile is showing, so the
  // client's mark-watched button can hit /episodes/:id/watch
  // for precisely that episode.
  const showTile = (r: any) => ({
    kind: "show" as const,
    id: r.show_id,
    title: r.show_title,
    poster: r.poster_url,
    backdrop: r.backdrop_url,
    still: r.still_url,
    episodeId: r.episode_id,
    season: r.season_number,
    number: r.number,
    episodeTitle: r.episode_title,
    count: r.unwatched_aired,
    // Mid-round tiles carry the round for the client's ↻ chip — the same
    // { round, startedAt } object every other surface calls `rewatch`
    // (shared/rewatch.ts), so one shape covers the whole API.
    ...(r.rewatch_round != null
      ? { rewatch: { round: r.rewatch_round, startedAt: r.rewatch_started } satisfies RewatchRef }
      : {}),
  });
  const continueWatching: any[] = [];
  const notStarted: any[] = [];
  const havenWatched: any[] = [];
  for (const r of results as any[]) {
    // A round's start counts as watch activity: starting a rewatch on a
    // long-finished show puts it straight into Continue Watching, not the
    // "Haven't watched for a while" bucket its old dates would earn.
    const lastWatched =
      r.rewatch_started != null && (r.last_watched == null || r.rewatch_started > r.last_watched)
        ? r.rewatch_started
        : r.last_watched;
    // Not Started tiles carry when the show was followed: Watch Later movies
    // merge into that section below, and the whole rail sorts by added-at.
    if (lastWatched == null) notStarted.push({ ...showTile(r), addedAt: r.added_at });
    else if (recentlyActive(lastWatched, r.last_aired, recentSince)) continueWatching.push(showTile(r));
    else havenWatched.push(showTile(r));
  }

  // Upcoming: the soonest unaired episode per followed show.
  const { results: upcomingR } = await c.env.DB.prepare(
    `WITH upc AS (
       SELECT e.id AS episode_id, e.show_id, e.season_number, e.number, e.title AS episode_title, e.air_date,
              s.title AS show_title, s.poster_url, s.backdrop_url,
              ROW_NUMBER() OVER (PARTITION BY e.show_id ORDER BY e.air_date, e.season_number, e.number) AS rn
       FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
       WHERE e.show_id IN (SELECT show_id FROM user_shows WHERE user_id = ?1 AND state = 'watching')
         AND e.season_number > 0 AND e.air_date IS NOT NULL AND e.air_date > ?2
     )
     SELECT episode_id, show_id, season_number, number, episode_title, air_date, show_title, poster_url, backdrop_url
     FROM upc WHERE rn = 1
     ORDER BY air_date, show_title, season_number, number
     LIMIT 30`
  )
    .bind(uid, today)
    .all();
  const upcoming = (upcomingR as any[]).map((r) => ({
    kind: "show" as const,
    id: r.show_id,
    title: r.show_title,
    poster: r.poster_url,
    backdrop: r.backdrop_url,
    still: null,
    season: r.season_number,
    number: r.number,
    episodeTitle: r.episode_title,
    // Date-only 'YYYY-MM-DD'; the query guarantees it exists and is in the
    // future. Feeds the tile's date pill.
    airDate: r.air_date,
  }));

  // History: recently watched episodes and movies, newest first. The batch
  // also carries the "From People You Follow" query: shows the
  // people you follow watched recently, one tile per show attributed to the
  // most recent watcher (a popular show is one tile, not one per follower).
  // Each tile also carries the exact episode behind that winning watch so the
  // client can name it and deep-link to it. Tiebreaks
  // preserve the section's original attribution: watchers tied on timestamp
  // still resolve by username first; only then, within the credited watcher's
  // rows (a bulk mark-watched stamps many episodes with one timestamp), does
  // the furthest episode win — the followee's actual progress point.
  //
  // Movies join the same rail: a parallel query, deduped one tile
  // per movie by most-recent watcher, is merged with the episode tiles below
  // and sorted by watch time within the shared cap — the same episode+movie
  // merge the History rail already does. user_movies carries no hidden flag
  // (the hidden-show privacy toggle is show-only, and the watch-notification
  // fan-out likewise hidden-filters shows only), so movies need no hidden
  // exclusion — just the same followee-visibility gate and follow window.
  const followSince = new Date(Date.now() - FOLLOWING_WINDOW_MS).toISOString();
  const [histEp, histMov, friendsR, friendsMovR, wlMovR, libR] = await c.env.DB.batch([
    // History rail: ONE ROW PER PLAY, from the dated history itself
    // (user_episode_plays, walked newest-first on its (user_id, watched_at)
    // index). It used to read user_episodes and collapse an episode to its
    // single newest date, which meant a rewatch didn't join the log, it
    // OVERWROTE the first watch in it — on the app's only chronological
    // surface, for the one feature whose promise is that history is never
    // lost. Letterboxd's diary, Trakt's history and Simkl's history popup all
    // list every play; so does this now.
    //
    // Each row also reports the rewatch round its play belongs to, if any: a
    // play stamped inside a round's window (>= its start, and not after it
    // closed — an open round has no close) was part of that rerun, and the
    // tile marks it. Without this a rewatch in the log is pixel-identical to
    // a first watch. Correlated over the 30 rows the rail actually shows.
    //
    // One BULK mark is one entry, not one per episode. "Mark all watched" —
    // the documented way to finish a rewatch round — stamps every aired
    // episode with a single shared timestamp, so on a 78-episode show it used
    // to consume all 30 slots of this rail with 30 identical tiles at the
    // same instant: the feature's own finishing move wiped the only surface
    // that answers "what did I actually watch?". Trakt, Simkl and Letterboxd
    // all collapse a bulk mark into one entry; so does this. Grouping is on
    // (show, exact timestamp), which is precisely what a bulk call produces —
    // individually tapped plays each get their own ms-stamped nowIso() and
    // stay their own tiles. The representative episode is the FURTHEST one in
    // the group (the progress point), the same tiebreak the followees' rail
    // uses, and `episodes` tells the client how many went with it.
    c.env.DB.prepare(
      `WITH ts AS (
         -- Bound the work first: the newest distinct play timestamps, read
         -- straight off idx_user_episode_plays_user_watched. Grouping the
         -- whole history to take 30 rows off the top would walk every play
         -- the account has.
         SELECT DISTINCT p.watched_at AS watched_at FROM user_episode_plays p
         WHERE p.user_id = ?1 ORDER BY p.watched_at DESC LIMIT 30
       ),
       g AS (
         -- One row per (show, exact stamp), carrying its size and the
         -- episode that stands for it: the furthest one in the group, which
         -- is where the sweep left the viewer. Picked by ROW_NUMBER rather
         -- than a MAX() the outer query has to re-resolve, so the tile joins
         -- on an episode PRIMARY KEY and one group can only ever be one tile.
         SELECT show_id, watched_at, episodes, episode_id FROM (
           SELECT e.show_id AS show_id, p.watched_at AS watched_at, e.id AS episode_id,
                  COUNT(*) OVER (PARTITION BY e.show_id, p.watched_at) AS episodes,
                  ROW_NUMBER() OVER (PARTITION BY e.show_id, p.watched_at
                                     ORDER BY e.season_number DESC, e.number DESC, e.id DESC) AS rn
           FROM user_episode_plays p JOIN episodes e ON e.id = p.episode_id
           WHERE p.user_id = ?1 AND e.season_number > 0
             AND p.watched_at IN (SELECT watched_at FROM ts)
         ) WHERE rn = 1
         ORDER BY watched_at DESC LIMIT 30
       )
       SELECT g.show_id AS id, s.title AS show_title, s.poster_url, s.backdrop_url, e.still_url,
              e.season_number, e.number, e.title AS episode_title,
              g.watched_at AS watched_at, g.episodes AS episodes,
              (SELECT MAX(rw.round) FROM user_show_rewatches rw
                 WHERE rw.user_id = ?1 AND rw.show_id = g.show_id
                   AND g.watched_at >= rw.started_at
                   AND (rw.finished_at IS NULL OR g.watched_at <= rw.finished_at)) AS rewatch_round
       FROM g
       JOIN shows s ON s.tmdb_id = g.show_id
       JOIN episodes e ON e.id = g.episode_id
       ORDER BY g.watched_at DESC`
    ).bind(uid),
    // Movies keep the rail honest the same way: user_movie_plays, one row per
    // viewing. user_movies holds a single watched_at, so a comfort movie
    // logged three times used to appear once — the Letterboxd diary case this
    // table exists for. Same set of movies either way (a play row exists for
    // exactly the watched ones; unwatching drops both).
    c.env.DB.prepare(
      `SELECT m.tmdb_id AS id, m.title, m.poster_url, p.watched_at
       FROM user_movie_plays p JOIN movies m ON m.tmdb_id = p.movie_id
       WHERE p.user_id = ?1
       ORDER BY p.watched_at DESC LIMIT 30`
    ).bind(uid),
    c.env.DB.prepare(
      `WITH following(fid) AS (
         -- Only followees whose activity this viewer may see,
         -- mirroring social.ts's FOLLOWING_CTE: profile public or mutual — a
         -- self-granted follow alone unlocks nothing. The separate
         -- activity_public gate was dropped: an earlier change removed the eye
         -- toggle that set that flag, freezing it, so gating on it permanently
         -- hid the activity of any user whose flag was 0 from their followers,
         -- with no way to turn it back on.
         SELECT f.followee_id FROM follows f
         JOIN users fu ON fu.id = f.followee_id
         WHERE f.follower_id = ?1 AND f.state = 'active'
           AND (fu.profile_public = 1 OR EXISTS (
             SELECT 1 FROM follows r
             WHERE r.follower_id = f.followee_id AND r.followee_id = ?1 AND r.state = 'active'))
       ),
       fw AS (
         SELECT e.show_id, u.username, ue.user_id,
                e.id AS episode_id, e.season_number, e.number, e.title AS episode_title,
                CASE WHEN ue.last_rewatched_at > ue.watched_at
                     THEN ue.last_rewatched_at ELSE ue.watched_at END AS ts
         FROM user_episodes ue
         JOIN following fo ON fo.fid = ue.user_id
         JOIN users u ON u.id = ue.user_id AND u.deleted_at IS NULL
         JOIN episodes e ON e.id = ue.episode_id
         WHERE (ue.watched_at >= ?2 OR ue.last_rewatched_at >= ?2) AND e.season_number > 0
           -- A followee's hidden show is private activity: keep
           -- it out of the rail exactly like the activity feed does.
           AND NOT EXISTS (SELECT 1 FROM user_shows h
                           WHERE h.user_id = ue.user_id AND h.show_id = e.show_id AND h.hidden = 1)
       )
       SELECT f.show_id, f.username, f.user_id, f.episode_id, f.season_number, f.number, f.episode_title, f.ts,
              s.title AS show_title, s.poster_url, s.backdrop_url
       FROM (SELECT *, ROW_NUMBER() OVER (
               PARTITION BY show_id
               ORDER BY ts DESC, username, season_number DESC, number DESC) AS rn
             FROM fw) f
       JOIN shows s ON s.tmdb_id = f.show_id
       WHERE f.rn = 1
       ORDER BY f.ts DESC
       LIMIT 30`
    ).bind(uid, followSince),
    c.env.DB.prepare(
      `WITH following(fid) AS (
         -- The same followee-visibility gate as the episode rail above:
         -- profile public or mutual (no activity_public gate).
         SELECT f.followee_id FROM follows f
         JOIN users fu ON fu.id = f.followee_id
         WHERE f.follower_id = ?1 AND f.state = 'active'
           AND (fu.profile_public = 1 OR EXISTS (
             SELECT 1 FROM follows r
             WHERE r.follower_id = f.followee_id AND r.followee_id = ?1 AND r.state = 'active'))
       ),
       fwm AS (
         SELECT um.movie_id, u.username, um.user_id, um.watched_at AS ts
         FROM user_movies um
         JOIN following fo ON fo.fid = um.user_id
         JOIN users u ON u.id = um.user_id AND u.deleted_at IS NULL
         WHERE um.state = 'watched' AND um.watched_at IS NOT NULL AND um.watched_at >= ?2
       )
       SELECT f.movie_id, f.username, f.user_id, f.ts, m.title, m.poster_url
       FROM (SELECT *, ROW_NUMBER() OVER (
               PARTITION BY movie_id
               ORDER BY ts DESC, username) AS rn
             FROM fwm) f
       JOIN movies m ON m.tmdb_id = f.movie_id
       WHERE f.rn = 1
       ORDER BY f.ts DESC
       LIMIT 30`
    ).bind(uid, followSince),
    // The user's Watch Later movies, for the Not Started rail below. No
    // LIMIT: the section has never been capped (the /watch/notstarted page
    // shows it whole), and the Library's Watch Later subtab already loads the
    // full list. added_at DESC puts NULLs (rows predating 0038) last, where
    // movie_id DESC keeps the old Watch Later recency proxy as their order.
    c.env.DB.prepare(
      `SELECT m.tmdb_id AS id, m.title, m.poster_url, um.added_at
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watchlist'
       ORDER BY um.added_at DESC, um.movie_id DESC`
    ).bind(uid),
    // Whether anything is in the library at all — any show state, any movie
    // state. An empty home isn't a reliable proxy (History and From People
    // You Follow can fill it while the library holds nothing), so the flag
    // is explicit: it sends the client's first-show nudge, which walks the
    // user to Search and asks what they're watching.
    c.env.DB.prepare(
      `SELECT (EXISTS (SELECT 1 FROM user_shows WHERE user_id = ?1)
            OR EXISTS (SELECT 1 FROM user_movies WHERE user_id = ?1)) AS has_library`
    ).bind(uid),
  ]);
  const history: any[] = [
    ...(histEp.results as any[]).map((r) => ({
      kind: "show" as const,
      id: r.id,
      title: r.show_title,
      poster: r.poster_url,
      backdrop: r.backdrop_url,
      still: r.still_url,
      season: r.season_number,
      number: r.number,
      episodeTitle: r.episode_title,
      watchedAt: r.watched_at,
      // How many episodes went in on this one stamp. 1 for a normal tap, and
      // the client keeps naming the episode; >1 means a bulk mark and the
      // tile says "78 episodes" instead of pretending to be one of them.
      ...(r.episodes > 1 ? { episodes: r.episodes } : {}),
      // The round this play went into, so the rail can mark a rerun. Round
      // only: that round may have closed months ago, so it names an
      // attribution, not an open session (shared/rewatch.ts).
      ...(r.rewatch_round != null ? { rewatch: { round: r.rewatch_round } satisfies RewatchRef } : {}),
    })),
    ...(histMov.results as any[]).map((r) => ({
      kind: "movie" as const,
      id: r.id,
      title: r.title,
      poster: r.poster_url,
      backdrop: null,
      still: null,
      watchedAt: r.watched_at,
    })),
  ]
    .sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1))
    .slice(0, 30);

  // Episode and movie tiles share one rail, newest first, capped as the
  // section always was — the same merge/sort/slice the History
  // rail uses. Movie tiles carry no episode fields, so the client's generic
  // Tile links them to /movie/:id and still credits the watcher.
  const friendsRows: any[] = [
    ...(friendsR.results as any[]).map((r) => ({
      kind: "show" as const,
      id: r.show_id,
      title: r.show_title,
      poster: r.poster_url,
      backdrop: r.backdrop_url,
      still: null,
      username: r.username,
      ownerId: r.user_id,
      episodeId: r.episode_id,
      season: r.season_number,
      number: r.number,
      episodeTitle: r.episode_title,
      watchedAt: r.ts,
    })),
    ...(friendsMovR.results as any[]).map((r) => ({
      kind: "movie" as const,
      id: r.movie_id,
      title: r.title,
      poster: r.poster_url,
      backdrop: null,
      still: null,
      username: r.username,
      ownerId: r.user_id,
      watchedAt: r.ts,
    })),
  ]
    .sort((a, b) => (a.watchedAt < b.watchedAt ? 1 : -1))
    .slice(0, 30);

  // Reaction state for the rail (#20): every tile carries its total reaction
  // count and the viewer's own reaction so the thumbs-up control renders
  // without a per-tile fetch. One grouped query over the rail's watchers (30
  // tiles max, so the IN list stays well under D1's bound-parameter cap);
  // grouped rows for activities not on the rail simply miss the lookup below.
  // ownerId is internal plumbing — the payload keeps exposing usernames only,
  // so it's stripped in the map (the reaction endpoint takes the username).
  const reactions = new Map<string, { n: number; mine: string | null }>();
  if (friendsRows.length) {
    const owners = [...new Set<number>(friendsRows.map((t) => t.ownerId))];
    const placeholders = owners.map((_, i) => `?${i + 2}`).join(",");
    const { results: reactR } = await c.env.DB.prepare(
      `SELECT owner_id, target_type, target_id, COUNT(*) AS n,
              MAX(CASE WHEN reactor_id = ?1 THEN reaction END) AS mine
       FROM activity_reactions
       WHERE owner_id IN (${placeholders})
       GROUP BY owner_id, target_type, target_id`
    )
      .bind(uid, ...owners)
      .all();
    for (const r of reactR as any[]) {
      reactions.set(`${r.owner_id}:${r.target_type}:${r.target_id}`, { n: r.n, mine: r.mine ?? null });
    }
  }
  const friendsWatched = friendsRows.map(({ ownerId, ...t }) => {
    const r = reactions.get(`${ownerId}:${t.kind}:${t.id}`);
    return { ...t, reactionCount: r?.n ?? 0, myReaction: r?.mine ?? null };
  });

  // Watch Later movies join the Not Started rail (#16): both buckets are
  // titles the user queued but hasn't begun, so they share one section,
  // sorted by when each was added — save a movie and it lands first. Movie
  // tiles are kind:'movie' with no episode fields, so the client's poster-art
  // treatment renders them like the show tiles — poster, title, no episode
  // meta, no mark-watched — linking to /movie/:id. Movies saved before
  // user_movies.added_at existed sort as oldest (addedAt null → ""), and the
  // stable sort keeps the SQL movie_id-DESC proxy as their relative order;
  // shows' user_shows.added_at is NOT NULL so they always carry a timestamp.
  for (const r of wlMovR.results as any[]) {
    notStarted.push({
      kind: "movie" as const,
      id: r.id,
      title: r.title,
      poster: r.poster_url,
      backdrop: null,
      still: null,
      addedAt: r.added_at,
    });
  }
  const addedKey = (t: any) => t.addedAt ?? "";
  notStarted.sort((a, b) => (addedKey(a) < addedKey(b) ? 1 : addedKey(a) > addedKey(b) ? -1 : 0));

  return c.json({
    continueWatching,
    upcoming,
    havenWatched,
    notStarted,
    history,
    friendsWatched,
    libraryEmpty: !(libR.results[0] as any)?.has_library,
  });
});

// ---------- Library & watchlist ----------

library.get("/library", async (c) => {
  // The owner's own library carries the Watch Later buckets AND
  // their hidden shows — both opt-in, so the public route (which
  // calls libraryPayload without either flag) can never serve the private
  // watchlist or a hidden show. Hidden shows must stay visible HERE so the
  // owner can find and unhide them without losing progress. Rewatch
  // round-awareness is opt-in the same way: the public library keeps its
  // lifetime counts and unchanged payload shape (public rewatch surfaces are
  // deliberately out of scope).
  return c.json(
    await libraryPayload(c.env.DB, c.get("uid"), c.get("tz"), { watchlist: true, includeHidden: true, rewatch: true })
  );
});

// No Library page fetches this anymore — Watch Later moved into the Shows and
// Movies subtabs off the /library payload. It stays for the
// offline precache pass (precache.ts warms watchlist titles from it) and for
// stale service-worker-cached clients still rendering the old Watchlist tab.
library.get("/watchlist", async (c) => {
  const uid = c.get("uid");
  const [showsR, moviesR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT us.show_id AS id, s.title, s.poster_url AS poster, s.first_air_date
       FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
       WHERE us.user_id = ?1 AND us.state = 'watch_later' ORDER BY us.added_at DESC`
    ).bind(uid),
    c.env.DB.prepare(
      // Same saved-order sort as the Library's Watch Later subtab: added_at
      // (0038) newest first, NULLs (pre-0038 rows) last by movie_id DESC —
      // the proxy this query's old "ORDER BY rowid DESC" (movies.rowid,
      // i.e. the same tmdb_id) approximated.
      `SELECT um.movie_id AS id, m.title, m.poster_url AS poster, m.release_date
       FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
       WHERE um.user_id = ?1 AND um.state = 'watchlist'
       ORDER BY um.added_at DESC, um.movie_id DESC`
    ).bind(uid),
  ]);
  return c.json({ shows: showsR.results, movies: moviesR.results });
});

// ---------- Follow / show state ----------

library.put("/shows/:id/follow", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  // 'hidden' here is the hidden-show tombstone (a hidden show that was
  // unfollowed): following it again resurrects it as watching — the hidden
  // FLAG rides along untouched, so the privacy choice stays sticky.
  await c.env.DB.prepare(
    `INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2)
     ON CONFLICT (user_id, show_id) DO UPDATE
       SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_shows.state IN ('watch_later', 'stopped', 'hidden')`
  )
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.delete("/shows/:id/follow", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");

  // Unfollowing a show you're partway through ABANDONS it: the
  // standalone "Abandon show" button is gone, so this endpoint now carries that
  // flow. "Partially watched" is the exact rule the old PUT /shows/:id/state
  // abandon guard used and libraryPayload's deriveState uses — some aired
  // regular-season episodes watched, but not caught up — counted in the viewer's
  // timezone. Such a show drops into the 'stopped' state (staying in the
  // Library's Abandoned tab, seasons collapsed) instead of leaving the
  // library. Hidden rows are excluded — they keep the tombstone path below so
  // the hidden-show privacy flag survives the unfollow.
  const row = await c.env.DB.prepare(
    `SELECT
       us.hidden AS hidden,
       (SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
          WHERE ue.user_id = ?1 AND e.show_id = ?2 AND e.season_number > 0) AS watched,
       (SELECT COUNT(*) FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
          WHERE e.show_id = ?2 AND e.season_number > 0 AND ${airedCond("?3", "s")}) AS aired
     FROM user_shows us WHERE us.user_id = ?1 AND us.show_id = ?2`
  )
    .bind(uid, id, todayInTz(c.get("tz")))
    .first<{ hidden: number; watched: number; aired: number }>();
  if (row && row.hidden === 0 && row.watched > 0 && row.watched < row.aired) {
    await c.env.DB.prepare(
      `UPDATE user_shows SET state = 'stopped', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?1 AND show_id = ?2`
    )
      .bind(uid, id)
      .run();
    return c.json({ ok: true, state: "stopped" });
  }

  // Otherwise: plain unfollow, which keeps watch history (user_episodes) — TV
  // Time behavior. A HIDDEN show can't just drop its row: the
  // privacy flag lives on it, and the history that stays behind would reappear
  // on the public profile. Tombstone it instead — the legacy state 'hidden'
  // every read surface already treats as not-tracked — so unfollow works and the
  // flag survives.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2 AND hidden = 0").bind(uid, id),
    c.env.DB.prepare(
      `UPDATE user_shows SET state = 'hidden', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?1 AND show_id = ?2 AND hidden = 1`
    ).bind(uid, id),
  ]);
  return c.json({ ok: true });
});

// Full removal: for accidental adds — wipe every trace of the
// show from this user's account, not just the follow. Unlike unfollow, this
// deletes watch history, ratings, and favorites/list memberships too.
library.delete("/shows/:id/remove", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM user_episode_plays WHERE user_id = ?1 AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?2)"
    ).bind(uid, id),
    c.env.DB.prepare("DELETE FROM user_show_rewatches WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
    c.env.DB.prepare(
      "DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?2)"
    ).bind(uid, id),
    c.env.DB.prepare(
      "DELETE FROM episode_character_votes WHERE user_id = ?1 AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?2)"
    ).bind(uid, id),
    c.env.DB.prepare(
      `DELETE FROM ratings WHERE user_id = ?1 AND (
         (target_type = 'show' AND target_id = ?2)
         OR (target_type = 'episode' AND target_id IN (SELECT id FROM episodes WHERE show_id = ?2)))`
    ).bind(uid, id),
    c.env.DB.prepare(
      `DELETE FROM custom_list_items WHERE target_type = 'show' AND target_id = ?2
         AND list_id IN (SELECT id FROM custom_lists WHERE user_id = ?1)`
    ).bind(uid, id),
    c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
  ]);
  return c.json({ ok: true });
});

library.put("/shows/:id/state", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const state = String(body.state ?? "");
  if (!id || !(STORED_SHOW_STATES as readonly string[]).includes(state)) return c.json({ error: "bad request" }, 400);
  if (state === "stopped") {
    // Abandoning only makes sense mid-show: an unwatched show
    // should be removed instead, and one with every aired episode watched is
    // finished/caught up, not abandoned. Same counting as libraryPayload's
    // deriveState — regular seasons only (season_number > 0), aired per the
    // shared airedCond rule in the viewer's timezone. The UI hides Abandon in
    // these cases; this rejects stale or hand-crafted requests to match.
    const row = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
            WHERE ue.user_id = ?1 AND e.show_id = ?2 AND e.season_number > 0) AS watched,
         (SELECT COUNT(*) FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
            WHERE e.show_id = ?2 AND e.season_number > 0 AND ${airedCond("?3", "s")}) AS aired`
    )
      .bind(c.get("uid"), id, todayInTz(c.get("tz")))
      .first<{ watched: number; aired: number }>();
    if (!row || row.watched === 0 || row.watched >= row.aired)
      return c.json({ error: "only a partially watched show can be abandoned" }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE user_shows SET state = ?3, last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?1 AND show_id = ?2`
  )
    .bind(c.get("uid"), id, state)
    .run();
  return c.json({ ok: true });
});

// Per-user privacy flag: hide a show from every outward surface
// — public profile history rows, public library, activity feed, also-watching,
// the followee rail, and notifications about it — while it stays fully intact
// (state, progress, history) in the owner's own library.
//
// The flag needs a user_shows row to live on, but a show can leak from watch
// history alone (unfollow keeps user_episodes). Hiding such a row-less show
// INSERTs a TOMBSTONE — the legacy state 'hidden', which every read surface
// (including the owner's own library) already treats as not-tracked — so
// hiding never re-follows anything. Unhiding clears the flag and deletes a
// tombstone outright (back to plain history-only); it never inserts, so an
// unhide can't conjure up a library row either.
library.put("/shows/:id/hidden", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  if (!id || typeof body.hidden !== "boolean") return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");
  if (body.hidden) {
    await ensureShow(c.env, id);
    await c.env.DB.prepare(
      `INSERT INTO user_shows (user_id, show_id, state, hidden) VALUES (?1, ?2, 'hidden', 1)
       ON CONFLICT (user_id, show_id) DO UPDATE SET hidden = 1`
    )
      .bind(uid, id)
      .run();
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE user_shows SET hidden = 0 WHERE user_id = ?1 AND show_id = ?2").bind(uid, id),
      c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2 AND state = 'hidden'").bind(uid, id),
    ]);
  }
  return c.json({ ok: true });
});

library.put("/shows/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  // A tombstone (state 'hidden' — a hidden show that was
  // unfollowed) resurrects as watch-later; any other existing row is
  // untouched, as before. The hidden flag rides along either way.
  await c.env.DB.prepare(
    `INSERT INTO user_shows (user_id, show_id, state) VALUES (?1, ?2, 'watch_later')
     ON CONFLICT (user_id, show_id) DO UPDATE
       SET state = 'watch_later', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_shows.state = 'hidden'`
  )
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});

library.delete("/shows/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  // Same tombstone rule as unfollow: a hidden watch-later row
  // keeps its privacy flag on a tombstone instead of vanishing with it.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM user_shows WHERE user_id = ?1 AND show_id = ?2 AND state = 'watch_later' AND hidden = 0").bind(uid, id),
    c.env.DB.prepare(
      `UPDATE user_shows SET state = 'hidden', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?1 AND show_id = ?2 AND state = 'watch_later' AND hidden = 1`
    ).bind(uid, id),
  ]);
  return c.json({ ok: true });
});

// ---------- Favorites ----------
// Favorites live in a system list (custom_lists.kind = 'favorites'),
// auto-created the first time something is favorited.

async function favoritesListId(c: Context<AppEnv>, create: boolean): Promise<number | null> {
  const uid = c.get("uid");
  const row = await c.env.DB.prepare("SELECT id FROM custom_lists WHERE user_id = ?1 AND kind = 'favorites'")
    .bind(uid)
    .first<{ id: number }>();
  if (row) return row.id;
  if (!create) return null;
  const created = await c.env.DB.prepare(
    "INSERT INTO custom_lists (user_id, name, kind) VALUES (?1, 'Favorites', 'favorites') RETURNING id"
  )
    .bind(uid)
    .first<{ id: number }>();
  return created!.id;
}

library.put("/shows/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureShow(c.env, id);
  const uid = c.get("uid");
  const listId = await favoritesListId(c, true);
  // RETURNING detects the transition INTO favorited: the ON CONFLICT no-op
  // returns nothing, so re-PUTting an existing favorite never re-notifies.
  const created = await c.env.DB.prepare(
    `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
     SELECT ?1, 'show', ?2, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
     ON CONFLICT (list_id, target_type, target_id) DO NOTHING
     RETURNING list_id`
  )
    .bind(listId, id)
    .first();
  // Notify followers, off the response path — the same hook
  // shape as the watch routes. The fan-out itself skips shows this user hid
  // and dedupes per actor/title per day, so an unfavorite/refavorite
  // flap stays one notification.
  if (created) {
    c.executionCtx.waitUntil(
      notifyFollowersOfFavorite(c.env, uid, "show", id).catch((e) => console.error("notify failed", e))
    );
  }
  return c.json({ ok: true });
});

library.delete("/shows/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const listId = await favoritesListId(c, false);
  if (listId != null) {
    await c.env.DB.prepare("DELETE FROM custom_list_items WHERE list_id = ?1 AND target_type = 'show' AND target_id = ?2")
      .bind(listId, id)
      .run();
  }
  return c.json({ ok: true });
});

library.put("/movies/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureMovie(c.env, id);
  const uid = c.get("uid");
  const listId = await favoritesListId(c, true);
  // Same transition detection + follower fan-out as the show route above.
  const created = await c.env.DB.prepare(
    `INSERT INTO custom_list_items (list_id, target_type, target_id, position)
     SELECT ?1, 'movie', ?2, COALESCE(MAX(position) + 1, 0) FROM custom_list_items WHERE list_id = ?1
     ON CONFLICT (list_id, target_type, target_id) DO NOTHING
     RETURNING list_id`
  )
    .bind(listId, id)
    .first();
  if (created) {
    c.executionCtx.waitUntil(
      notifyFollowersOfFavorite(c.env, uid, "movie", id).catch((e) => console.error("notify failed", e))
    );
  }
  return c.json({ ok: true });
});

library.delete("/movies/:id/favorite", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const listId = await favoritesListId(c, false);
  if (listId != null) {
    await c.env.DB.prepare("DELETE FROM custom_list_items WHERE list_id = ?1 AND target_type = 'movie' AND target_id = ?2")
      .bind(listId, id)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- Rewatch rounds ----------
// A round is one explicit rewatch run of a show (round 2 = first rewatch —
// the original watch is implicitly round 1), tracked in user_show_rewatches
// (0043). Progress lives in user_episode_plays: an episode is "watched this
// round" when it has a play with watched_at >= started_at — >= and never >,
// so a play stamped at exactly the round's start still counts.

// The show's active round (finished_at IS NULL), if any. At most one per
// show; the start route 409s rather than stacking a second. `prev_state`
// is the user_shows.state the round displaced — see restoreShowState.
async function activeRound(
  db: D1Database,
  uid: number,
  showId: number
): Promise<{ round: number; started_at: string; prev_state: string | null } | null> {
  return db
    .prepare(
      `SELECT round, started_at, prev_state FROM user_show_rewatches
       WHERE user_id = ?1 AND show_id = ?2 AND finished_at IS NULL`
    )
    .bind(uid, showId)
    .first<{ round: number; started_at: string; prev_state: string | null }>();
}

// Starting a round forces user_shows.state to 'watching' — that flip is what
// puts the show back in Library Watching and Watch Next, the whole point over
// TV Time. It is also a MUTATION OF THE USER'S OWN CHOICE, so the round row
// remembers what it displaced and hands it back the moment the round ends,
// however it ends (auto-complete, cancel). Without this an abandoned show
// rewatched once never returns to the Abandoned tab, and an unfollowed
// hidden show (state 'hidden' — the privacy tombstone) silently reappears in
// the library forever.
//
// Only ever restores a state we ourselves set: the WHERE clause requires the
// row to still say 'watching', so a state the user changed mid-round (Resume,
// Abandon, watch-later) is left exactly as they left it. prev_state NULL means
// there was no user_shows row at all — starting a rewatch on a show you'd
// unfollowed is an explicit "I'm tracking this again", so that follow stays.
async function restoreShowState(db: D1Database, uid: number, showId: number, prevState: string | null): Promise<void> {
  if (prevState == null || prevState === "watching") return;
  await db
    .prepare(
      `UPDATE user_shows SET state = ?3, last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE user_id = ?1 AND show_id = ?2 AND state = 'watching'`
    )
    .bind(uid, showId, prevState)
    .run();
}

// A finished round claims "I covered every aired episode". Removing one of
// its plays makes that false — so the round re-opens (finished_at back to
// NULL) rather than standing as a completed round the history no longer
// supports, with no way back in to finish it. The show returns to the queue
// with it, exactly as when the round was started.
//
// Only the LATEST round can re-open: at most one round may be active, and an
// older round's window is closed off by the rounds after it. Cheap enough to
// run after every un-watch — the lookup is a primary-key seek that finds
// nothing for the ~all shows that have never been rewatched.
async function reopenRoundIfIncomplete(c: Context<AppEnv>, uid: number, showId: number): Promise<void> {
  const last = await c.env.DB.prepare(
    `SELECT round, started_at, finished_at FROM user_show_rewatches
     WHERE user_id = ?1 AND show_id = ?2 ORDER BY round DESC LIMIT 1`
  )
    .bind(uid, showId)
    .first<{ round: number; started_at: string; finished_at: string | null }>();
  if (!last || last.finished_at == null) return;
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
     WHERE e.show_id = ?2 AND e.season_number > 0
       AND ${airedCond("?3", "s")}
       AND NOT EXISTS (SELECT 1 FROM user_episode_plays p
                       WHERE p.user_id = ?1 AND p.episode_id = e.id AND p.watched_at >= ?4)`
  )
    .bind(uid, showId, todayInTz(c.get("tz")), last.started_at)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) return;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE user_show_rewatches SET finished_at = NULL
       WHERE user_id = ?1 AND show_id = ?2 AND round = ?3 AND finished_at IS NOT NULL`
    ).bind(uid, showId, last.round),
    // Back in the queue, like any open round. prev_state is untouched — it
    // still remembers what the round displaced when it opened.
    c.env.DB.prepare(
      `INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2)
       ON CONFLICT (user_id, show_id) DO UPDATE
         SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    ).bind(uid, showId),
  ]);
}

// Auto-complete: when a watch action has just given every aired
// regular-season episode a this-round play, close the round. Returns whether
// it did — the caller's response then carries roundComplete: true, which
// drives the client's confetti. Specials (season 0) never gate completion,
// matching the rest of the app's progress accounting.
async function completeRoundIfDone(
  c: Context<AppEnv>,
  uid: number,
  showId: number,
  round: number,
  startedAt: string
): Promise<boolean> {
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
     WHERE e.show_id = ?2 AND e.season_number > 0
       AND ${airedCond("?3", "s")}
       AND NOT EXISTS (SELECT 1 FROM user_episode_plays p
                       WHERE p.user_id = ?1 AND p.episode_id = e.id AND p.watched_at >= ?4)`
  )
    .bind(uid, showId, todayInTz(c.get("tz")), startedAt)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) !== 0) return false;
  const closed = await c.env.DB.prepare(
    `UPDATE user_show_rewatches SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?1 AND show_id = ?2 AND round = ?3 AND finished_at IS NULL
     RETURNING prev_state`
  )
    .bind(uid, showId, round)
    .first<{ prev_state: string | null }>();
  // The round is over, so the state it borrowed goes back.
  if (closed) await restoreShowState(c.env.DB, uid, showId, closed.prev_state);
  return true;
}

library.post("/shows/:id/rewatch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  await ensureShow(c.env, id);
  if (await activeRound(c.env.DB, uid, id)) return c.json({ error: "a rewatch is already in progress" }, 409);

  // You can only re-watch what you've watched. The show page offers the
  // button on exactly this test (caught up: every aired regular-season
  // episode watched, and at least one has aired) and the server has to make
  // the same call, or a stale tab / a hand-rolled request opens "ROUND 2" on
  // a show with no history at all — a round chip over 0/27, a Library card
  // claiming a rerun of something never seen, and a permanent state flip to
  // 'watching' underneath it. Simkl only offers Add Rewatch on completed
  // shows; Trakt needs history. Counted like deriveState and PUT
  // /shows/:id/state: regular seasons only, aired per the shared rule in the
  // viewer's timezone. Also reads the state the round is about to displace.
  const row = await c.env.DB.prepare(
    `SELECT us.state AS state,
       (SELECT COUNT(*) FROM user_episodes ue JOIN episodes e ON e.id = ue.episode_id
          WHERE ue.user_id = ?1 AND e.show_id = ?2 AND e.season_number > 0) AS watched,
       (SELECT COUNT(*) FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
          WHERE e.show_id = ?2 AND e.season_number > 0 AND ${airedCond("?3", "s")}) AS aired
     FROM shows sh LEFT JOIN user_shows us ON us.user_id = ?1 AND us.show_id = ?2
     WHERE sh.tmdb_id = ?2`
  )
    .bind(uid, id, todayInTz(c.get("tz")))
    .first<{ state: string | null; watched: number; aired: number }>();
  if (!row) return c.json({ error: "unknown show" }, 404);
  if (row.aired === 0 || row.watched < row.aired)
    return c.json({ error: "There’s nothing to re-watch yet — catch up on this show first." }, 409);

  // Round numbering: 2 + count of existing rounds (canceled rounds are
  // deleted outright, so the count is completed rounds). Computed inside the
  // INSERT so the number can't race the check above. prev_state travels with
  // it so the end of the round can hand the show's state back.
  const round = await c.env.DB.prepare(
    `INSERT INTO user_show_rewatches (user_id, show_id, round, prev_state)
     SELECT ?1, ?2, 2 + COUNT(*), ?3 FROM user_show_rewatches WHERE user_id = ?1 AND show_id = ?2
     RETURNING round, started_at`
  )
    .bind(uid, id, row.state)
    .first<{ round: number; started_at: string }>();
  // Starting a round re-enters the show into Library Watching and Watch Next
  // — THE payoff over TV Time, where a finished show could only rejoin the
  // queue by destructively unwatching it. The hidden flag rides along, and
  // the displaced state is remembered above rather than overwritten for good.
  await c.env.DB.prepare(
    `INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2)
     ON CONFLICT (user_id, show_id) DO UPDATE
       SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  )
    .bind(uid, id)
    .run();
  return c.json({ round: round!.round, startedAt: round!.started_at });
});

library.delete("/shows/:id/rewatch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  // Cancel = delete the active round row, and put back the user_shows.state
  // it displaced. Plays are NEVER deleted by starting, finishing, or
  // canceling a round — every episode the user ever watched stays watched.
  // With the round gone the library derives finished/up_to_date from the
  // lifetime counts again, and Watch Next drops the show because nothing is
  // left unwatched; the state hand-back is what returns an abandoned or
  // unfollowed-and-hidden show to where the user actually put it.
  const round = await activeRound(c.env.DB, uid, id);
  if (!round) return c.json({ ok: true }); // nothing open — idempotent
  await c.env.DB.prepare(
    "DELETE FROM user_show_rewatches WHERE user_id = ?1 AND show_id = ?2 AND finished_at IS NULL"
  )
    .bind(uid, id)
    .run();
  await restoreShowState(c.env.DB, uid, id, round.prev_state);
  return c.json({ ok: true });
});

// ---------- Mark watched: episode / season / show ----------

library.post("/episodes/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const watchedAt = watchedAtFrom(await c.req.json().catch(() => ({})));
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));

  // Episode meta + whether this user has already watched it. Doubles as the
  // existence check (unknown id → 404) and feeds the "caught up" test below.
  // The show's active rewatch round rides along (LEFT JOIN — NULLs when none)
  // for the auto-complete check after the mark lands.
  const ep = await c.env.DB.prepare(
    `SELECT e.show_id, e.season_number, ${airedCond("?3", "s")} AS aired, s.title AS show_title,
            EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id) AS already,
            rw.round AS rw_round, rw.started_at AS rw_started
     FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
     LEFT JOIN user_show_rewatches rw ON rw.user_id = ?1 AND rw.show_id = e.show_id AND rw.finished_at IS NULL
     WHERE e.id = ?2`
  )
    .bind(uid, id, today)
    .first<{
      show_id: number;
      season_number: number;
      aired: number;
      show_title: string;
      already: number;
      rw_round: number | null;
      rw_started: string | null;
    }>();
  if (!ep) return c.json({ error: "unknown episode" }, 404);

  await c.env.DB.batch([
    // Marking an episode implies tracking the show; a watch-later show flips to watching.
    c.env.DB.prepare(
      `INSERT INTO user_shows (user_id, show_id)
       SELECT ?1, e.show_id FROM episodes e WHERE e.id = ?2
       ON CONFLICT (user_id, show_id) DO UPDATE
         SET state = 'watching', last_state_change = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE user_shows.state = 'watch_later'`
    ).bind(uid, id),
    // Re-marking a watched episode counts a rewatch — EXCEPT an exact replay
    // of a mark we already recorded (identical watched_at), which is a no-op.
    // The offline queue stamps watched_at at enqueue time and
    // can retry an op whose response was lost (tab died / 5xx after apply),
    // so the same timestamp arriving twice must not inflate play_count.
    // Genuine rewatches always carry a fresh "now" (or distinct backdate).
    //
    // The guard asks user_episode_plays, which 0043 made the source of truth,
    // NOT the row's two legacy date columns. Those hold only the first watch
    // and the LAST rewatch, so a replay of any play in between (or of any
    // play at all, once a third one lands and moves last_rewatched_at along)
    // slipped through and bumped play_count without adding a dated play — the
    // episode page then reported the difference as "+1 play with no date on
    // record", i.e. a pre-2026 legacy play, about a play created seconds ago.
    // This statement runs BEFORE the play insert below in the same batch, so
    // the row it is looking for is the one from the ORIGINAL mark.
    //
    // The two denormalized dates are folded with MIN/MAX rather than
    // overwritten, mirroring what removePlayStmts() recomputes on the way
    // out. A live mark always carries the newest timestamp, so this is a
    // no-op for it — but the Watch history's undo restores a play by POSTing
    // its ORIGINAL date, and a bare assignment would drag "last rewatched"
    // backwards to a play from 2018 while newer ones sit above it.
    c.env.DB.prepare(
      `INSERT INTO user_episodes (user_id, episode_id, watched_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, episode_id) DO UPDATE
         SET play_count = play_count + 1,
             watched_at = MIN(user_episodes.watched_at, excluded.watched_at),
             last_rewatched_at = MAX(
               COALESCE(user_episodes.last_rewatched_at, user_episodes.watched_at), excluded.watched_at)
         WHERE NOT EXISTS (SELECT 1 FROM user_episode_plays p
                           WHERE p.user_id = ?1 AND p.episode_id = ?2 AND p.watched_at = ?3)`
    ).bind(uid, id, watchedAt),
    // The dated play row (0043) — the append-only history underneath
    // play_count. The PK absorbs an identical-timestamp replay, the same
    // offline-queue retry guard the WHERE clause above implements.
    c.env.DB.prepare(
      "INSERT INTO user_episode_plays (user_id, episode_id, watched_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING"
    ).bind(uid, id, watchedAt),
  ]);

  // Notify followers, off the response path. Only this
  // one-episode "I just watched this" action notifies — the bulk paths
  // (season / watch-all / watch-until) are history backfill, and pinging
  // every follower because someone imported five old seasons is noise.
  // Fan-out dedupes per show per day, so a binge is still one notification.
  c.executionCtx.waitUntil(
    notifyFollowersOfWatch(c.env, uid, "show", ep.show_id, id).catch((e) => console.error("notify failed", e))
  );

  // Confetti trigger: this watch just caught the user up when it
  // was a *fresh* watch (not a rewatch) of an aired, regular-season episode
  // and no aired regular-season episode is left unwatched for the show. The
  // freshness + aired guards keep it from firing on rewatches or on shows that
  // were already fully caught up. Specials (season 0) never count, matching the
  // rest of the app's progress accounting.
  let caughtUp = false;
  if (!ep.already && ep.season_number > 0 && ep.aired) {
    const remaining = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM episodes e JOIN shows s ON s.tmdb_id = e.show_id
       WHERE e.show_id = ?2 AND e.season_number > 0
         AND ${airedCond("?3", "s")}
         AND NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)`
    )
      .bind(uid, ep.show_id, today)
      .first<{ n: number }>();
    caughtUp = (remaining?.n ?? 0) === 0;
  }

  // Round auto-complete: only a play that lands inside the round (watched_at
  // >= its start — a backdated mark is history-only) can finish it. The flag
  // ships only when this mark closed the round, and caughtUp above keeps its
  // first-watch-only rules untouched.
  let roundComplete = false;
  if (ep.rw_round != null && ep.rw_started != null && watchedAt >= ep.rw_started) {
    roundComplete = await completeRoundIfDone(c, uid, ep.show_id, ep.rw_round, ep.rw_started);
  }

  return c.json({
    ok: true,
    caughtUp,
    showTitle: ep.show_title,
    ...(roundComplete ? { roundComplete: true, round: ep.rw_round } : {}),
  });
});

// Drop ONE dated play and re-derive the row's denormalized columns from the
// plays that remain: earliest = the first watch, anything after it = the last
// rewatch, play_count one lower (floored at 1 — legacy rows can owe plays the
// old schema never dated). The row itself goes only when no play is left.
// Shared by every single-play removal so they can't drift apart.
function removePlayStmts(db: D1Database, uid: number, episodeId: number, watchedAt: string) {
  return [
    db
      .prepare("DELETE FROM user_episode_plays WHERE user_id = ?1 AND episode_id = ?2 AND watched_at = ?3")
      .bind(uid, episodeId, watchedAt),
    db
      .prepare(
        `UPDATE user_episodes SET play_count = MAX(play_count - 1, 1),
           watched_at = COALESCE((SELECT MIN(p.watched_at) FROM user_episode_plays p
                                  WHERE p.user_id = ?1 AND p.episode_id = ?2), watched_at),
           last_rewatched_at = (SELECT NULLIF(MAX(p.watched_at), MIN(p.watched_at)) FROM user_episode_plays p
                                WHERE p.user_id = ?1 AND p.episode_id = ?2)
         WHERE user_id = ?1 AND episode_id = ?2`
      )
      .bind(uid, episodeId),
    db
      .prepare(
        `DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2
           AND NOT EXISTS (SELECT 1 FROM user_episode_plays p WHERE p.user_id = ?1 AND p.episode_id = ?2)`
      )
      .bind(uid, episodeId),
  ];
}

// Un-tick an episode.
//
// WHAT COMES OFF IS THE CALLER'S CALL. It used to be decided from the round
// state the server happened to see when the request arrived, which is a
// different thing from what the user acted on — and the gap between them is
// where an undo turns into a purge. Three ways in: un-tick twice in a row
// (the second sees no this-round play and takes the destructive branch), two
// requests in flight at once (the loser sees the same thing), or — the one
// that needs no unusual behavior at all — a queued offline un-tick replayed
// after the round has closed, which is precisely what the offline queue does
// with this route. Each of those wiped an episode's ENTIRE dated history,
// under a dialog that promises "everything you've already watched stays
// watched". Trakt never destroys history on an un-tick either; removing a
// play is its own explicit action.
//
// So the scope travels in the request, and a replay can only ever do the
// thing the user asked for:
//   'round' — undo a round tick. Removes the latest play inside the latest
//     round window that has one (open OR closed: a round that auto-completed
//     between the tap and the replay is still the round the user was in), and
//     nothing else. Finds none → no-op, so a double-fire can't fall through
//     to something destructive.
//   'play'  — undo one viewing. Removes the newest play, whatever it was
//     part of. The episode stays watched if earlier plays remain.
//   'all'   — unwatch outright: the row and every dated play with it. The
//     explicit purge, for a client that means it.
// No scope (a client cached before this shipped) keeps the old behavior
// exactly: round-scoped while a round is genuinely open, destructive
// otherwise.
type UnwatchScope = "round" | "play" | "all";

library.delete("/episodes/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const uid = c.get("uid");
  const body = await c.req.json().catch(() => ({}));
  const raw = String((body as any)?.scope ?? "");
  const scope: UnwatchScope | null = raw === "round" || raw === "play" || raw === "all" ? raw : null;

  const [epR, roundR] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT e.show_id,
              (SELECT MAX(p.watched_at) FROM user_episode_plays p
                 WHERE p.user_id = ?1 AND p.episode_id = e.id) AS latest
       FROM episodes e WHERE e.id = ?2`
    ).bind(uid, id),
    // The play a round tick would be undoing: the newest one inside the
    // newest round window that holds any. `>=` on the start (never `>` —
    // Trakt's equality bug) and `<=` on the close.
    c.env.DB.prepare(
      `SELECT rw.round, rw.finished_at, MAX(p.watched_at) AS latest
       FROM episodes e
       JOIN user_show_rewatches rw ON rw.user_id = ?1 AND rw.show_id = e.show_id
       JOIN user_episode_plays p ON p.user_id = ?1 AND p.episode_id = e.id
            AND p.watched_at >= rw.started_at
            AND (rw.finished_at IS NULL OR p.watched_at <= rw.finished_at)
       WHERE e.id = ?2
       GROUP BY rw.round ORDER BY rw.round DESC LIMIT 1`
    ).bind(uid, id),
  ]);
  const ep = epR.results[0] as { show_id: number; latest: string | null } | undefined;
  if (!ep) return c.json({ error: "unknown episode" }, 404);
  const roundPlay = roundR.results[0] as { round: number; finished_at: string | null; latest: string } | undefined;

  // Legacy (no scope): the old rule, spelled out — round-scoped only while
  // the round is actually open.
  const effective: UnwatchScope = scope ?? (roundPlay && roundPlay.finished_at == null ? "round" : "all");

  if (effective === "round") {
    if (roundPlay) await c.env.DB.batch(removePlayStmts(c.env.DB, uid, id, roundPlay.latest));
  } else if (effective === "play") {
    if (ep.latest != null) await c.env.DB.batch(removePlayStmts(c.env.DB, uid, id, ep.latest));
    else await c.env.DB.prepare("DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2").bind(uid, id).run();
  } else {
    // Full unwatch: the row goes, and its dated plays go with it.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM user_episode_plays WHERE user_id = ?1 AND episode_id = ?2").bind(uid, id),
      c.env.DB.prepare("DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id = ?2").bind(uid, id),
    ]);
  }
  // A completed round that no longer covers every aired episode isn't
  // completed. Re-open it rather than leave a ×2 the history can't back.
  await reopenRoundIfIncomplete(c, uid, ep.show_id);
  return c.json({ ok: true });
});

// ---------- Paging the dated history ----------

// One page of older plays. The detail payload ships the newest PLAYS_LIMIT
// (routes/catalog.ts) so a comfort movie logged weekly for three years isn't
// 150 DOM nodes above the rating — but "history is never destroyed" is the
// whole promise of this feature, and a count of plays you cannot open is not
// a history. Letterboxd pages the diary and Trakt pages the play list; these
// two routes are the same thing, cursored on the timestamp the client already
// holds (the oldest row on screen) rather than an offset, so a removal or a
// new play mid-scroll can't shift the window and duplicate or skip a row.
const PLAYS_PAGE = 25;

// `?before=<iso>` — exclusive upper bound, the oldest play already loaded.
// Absent/garbage means "from the newest", which is the same page the detail
// payload already carries.
function beforeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// LIMIT one extra row is how `more` is known without a second COUNT: if the
// page came back full plus one, there is another page behind it.
function playsPage(rows: any[]): { plays: { watchedAt: string }[]; more: boolean } {
  const more = rows.length > PLAYS_PAGE;
  return { plays: rows.slice(0, PLAYS_PAGE).map((p) => ({ watchedAt: p.watched_at })), more };
}

library.get("/episodes/:id/plays", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const before = beforeCursor(c.req.query("before"));
  const r = await c.env.DB.prepare(
    `SELECT watched_at FROM user_episode_plays
     WHERE user_id = ?1 AND episode_id = ?2 AND (?3 IS NULL OR watched_at < ?3)
     ORDER BY watched_at DESC LIMIT ${PLAYS_PAGE + 1}`
  )
    .bind(c.get("uid"), id, before)
    .all();
  return c.json(playsPage(r.results as any[]));
});

library.get("/movies/:id/plays", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  const before = beforeCursor(c.req.query("before"));
  const r = await c.env.DB.prepare(
    `SELECT watched_at FROM user_movie_plays
     WHERE user_id = ?1 AND movie_id = ?2 AND (?3 IS NULL OR watched_at < ?3)
     ORDER BY watched_at DESC LIMIT ${PLAYS_PAGE + 1}`
  )
    .bind(c.get("uid"), id, before)
    .all();
  return c.json(playsPage(r.results as any[]));
});

// Remove ONE dated play — the Watch history rows' remove button on the
// episode page. The row's denormalized columns are recomputed from the plays
// that remain; removing the last play is a full unwatch (row deleted), same
// as DELETE /watch outside a round.
library.delete("/episodes/:id/plays", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const t = Date.parse(String(body?.watched_at ?? ""));
  const watchedAt = Number.isNaN(t) ? null : new Date(t).toISOString();
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");

  // Removing a play can invalidate a completed round, so the show is needed
  // either way. Unknown episode → 404 rather than a silent ok.
  const ep = await c.env.DB.prepare("SELECT show_id FROM episodes WHERE id = ?1")
    .bind(id)
    .first<{ show_id: number }>();
  if (!ep) return c.json({ error: "unknown episode" }, 404);

  const del = await c.env.DB.prepare("DELETE FROM user_episode_plays WHERE user_id = ?1 AND episode_id = ?2 AND watched_at = ?3")
    .bind(uid, id, watchedAt)
    .run();
  if ((del.meta.changes ?? 0) === 0) return c.json({ ok: true }); // already gone — idempotent

  // Re-derive the row's columns from the plays that remain (and drop it if
  // none do) — the same three statements every single-play removal uses. The
  // play itself is already gone above, which the first statement absorbs.
  await c.env.DB.batch(removePlayStmts(c.env.DB, uid, id, watchedAt));
  await reopenRoundIfIncomplete(c, uid, ep.show_id);
  return c.json({ ok: true });
});

// The episode span a bulk call sweeps: one season, everything up to and
// including SxxEyy (watch-until), or every regular season. `cond(n)` renders
// the SQL predicate with the scope's binds starting at placeholder ?n, so
// each statement below can lay its own parameters out first.
type BulkScope = { season?: number; until?: { season: number; number: number } };

function scopeSql(scope: BulkScope): { cond: (n: number) => string; binds: number[] } {
  if (scope.until != null) {
    const u = scope.until;
    return {
      cond: (n) =>
        `(e.season_number > 0 AND (e.season_number < ?${n} OR (e.season_number = ?${n} AND e.number <= ?${n + 1})))`,
      binds: [u.season, u.number],
    };
  }
  if (scope.season != null) return { cond: (n) => `e.season_number = ?${n}`, binds: [scope.season] };
  return { cond: () => "e.season_number > 0", binds: [] };
}

// Bulk mark/unmark, round-aware — season bulk marking MUST keep working
// mid-rewatch (Trakt v3 removed it; users revolted):
//   - outside a round, marking keeps its insert-if-new behavior, and each
//     newly watched episode also gets a dated play row (one shared timestamp);
//   - during a round, every aired target episode without a this-round play
//     gains one; rows that already existed bump play_count, new ones insert
//     with play_count 1 as usual. Re-running the same bulk mark mid-round is
//     a no-op — the NOT EXISTS guard is the bulk twin of the single-episode
//     replay dedupe.
// Returns { roundComplete, round } when the call just finished the active
// round, for the response flag that drives the client's confetti.
async function bulkWatch(
  c: Context<AppEnv>,
  showId: number,
  scope: BulkScope,
  unwatch: boolean,
  unwatchScope?: UnwatchScope | null
): Promise<{ roundComplete: boolean; round?: number }> {
  const uid = c.get("uid");
  const today = todayInTz(c.get("tz"));
  const round = await activeRound(c.env.DB, uid, showId);
  const { cond, binds } = scopeSql(scope);

  if (unwatch) {
    // Same rule as the single-episode un-tick: the CALLER says what it is
    // undoing, because this route is queued offline too and a replay must not
    // be able to upgrade "clear this season's round marks" into "delete this
    // season's entire history". 'round' works on the latest round's window
    // even if it has since closed; 'all' is the explicit purge; no scope
    // keeps the old server-state-derived behavior.
    const window =
      unwatchScope === "all"
        ? null
        : unwatchScope === "round"
          ? await c.env.DB
              .prepare(
                `SELECT started_at, finished_at FROM user_show_rewatches
                 WHERE user_id = ?1 AND show_id = ?2 ORDER BY round DESC LIMIT 1`
              )
              .bind(uid, showId)
              .first<{ started_at: string; finished_at: string | null }>()
          : round && { started_at: round.started_at, finished_at: null };
    if (unwatchScope === "round" && !window) {
      // The caller undid a round mark on a show that has no round on record
      // (canceled, or the request is a stale replay). There is nothing to
      // take back — and it must NEVER fall through to the purge below.
    } else if (window) {
      // Un-marking inside a round mirrors the single-episode DELETE /watch:
      // drop each episode's LATEST in-window play, step play_count back
      // (floor 1), keep the rows — history survives, checkmarks clear.
      // Binds: ?1 uid, ?2 show, ?3 window start, ?4 window end (NULL = open),
      // scope from ?5 (or ?3 where the window isn't needed).
      const inWindow = "p.watched_at >= ?3 AND (?4 IS NULL OR p.watched_at <= ?4)";
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE user_episodes SET play_count = MAX(play_count - 1, 1)
           WHERE user_id = ?1 AND episode_id IN
             (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${cond(5)}
                AND EXISTS (SELECT 1 FROM user_episode_plays p
                            WHERE p.user_id = ?1 AND p.episode_id = e.id AND ${inWindow}))`
        ).bind(uid, showId, window.started_at, window.finished_at, ...binds),
        c.env.DB.prepare(
          `DELETE FROM user_episode_plays WHERE user_id = ?1 AND (episode_id, watched_at) IN
             (SELECT p.episode_id, MAX(p.watched_at) FROM user_episode_plays p
              JOIN episodes e ON e.id = p.episode_id
              WHERE p.user_id = ?1 AND e.show_id = ?2 AND ${cond(5)} AND ${inWindow}
              GROUP BY p.episode_id)`
        ).bind(uid, showId, window.started_at, window.finished_at, ...binds),
        c.env.DB.prepare(
          `UPDATE user_episodes SET
             watched_at = COALESCE((SELECT MIN(p.watched_at) FROM user_episode_plays p
                                    WHERE p.user_id = ?1 AND p.episode_id = user_episodes.episode_id), watched_at),
             last_rewatched_at =
               (SELECT NULLIF(MAX(p.watched_at), MIN(p.watched_at)) FROM user_episode_plays p
                WHERE p.user_id = ?1 AND p.episode_id = user_episodes.episode_id)
           WHERE user_id = ?1 AND episode_id IN (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${cond(3)})`
        ).bind(uid, showId, ...binds),
        // Episodes whose only play ever was this round's don't stay watched.
        c.env.DB.prepare(
          `DELETE FROM user_episodes WHERE user_id = ?1
             AND episode_id IN (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${cond(3)})
             AND NOT EXISTS (SELECT 1 FROM user_episode_plays p
                             WHERE p.user_id = ?1 AND p.episode_id = user_episodes.episode_id)`
        ).bind(uid, showId, ...binds),
      ]);
    } else {
      // Outside a round: existing behavior — rows go, and their dated plays
      // go with them.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `DELETE FROM user_episode_plays WHERE user_id = ?1 AND episode_id IN
             (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${cond(3)})`
        ).bind(uid, showId, ...binds),
        c.env.DB.prepare(
          `DELETE FROM user_episodes WHERE user_id = ?1 AND episode_id IN
             (SELECT e.id FROM episodes e WHERE e.show_id = ?2 AND ${cond(3)})`
        ).bind(uid, showId, ...binds),
      ]);
    }
    // A completed round the remaining plays no longer cover re-opens.
    await reopenRoundIfIncomplete(c, uid, showId);
    return { roundComplete: false };
  }

  // One shared timestamp for the whole sweep, like today's bulk insert.
  const ts = nowIso();
  const stmts = [
    c.env.DB.prepare("INSERT INTO user_shows (user_id, show_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING").bind(uid, showId),
  ];
  if (round) {
    // Binds: ?1 uid, ?2 show, ?3 ts, ?4 today, ?5 round start, scope from ?6.
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO user_episode_plays (user_id, episode_id, watched_at)
         SELECT ?1, e.id, ?3 FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
         WHERE e.show_id = ?2 AND ${cond(6)}
           AND ${airedCond("?4", "sh")}
           AND NOT EXISTS (SELECT 1 FROM user_episode_plays p
                           WHERE p.user_id = ?1 AND p.episode_id = e.id AND p.watched_at >= ?5)
         ON CONFLICT DO NOTHING`
      ).bind(uid, showId, ts, today, round.started_at, ...binds),
      // Rows that existed before this call and just gained a play (the ?3
      // timestamp is unique to this sweep) count it as a rewatch. Runs
      // BEFORE the row insert below, so fresh rows keep play_count 1.
      c.env.DB.prepare(
        `UPDATE user_episodes SET play_count = play_count + 1, last_rewatched_at = ?3
         WHERE user_id = ?1 AND episode_id IN
           (SELECT p.episode_id FROM user_episode_plays p JOIN episodes e ON e.id = p.episode_id
            WHERE p.user_id = ?1 AND e.show_id = ?2 AND p.watched_at = ?3)`
      ).bind(uid, showId, ts)
    );
  } else {
    // Outside a round: dated plays only for episodes about to be newly
    // inserted — bulk marking has always been history backfill, so episodes
    // already watched are untouched (no play, no play_count bump).
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO user_episode_plays (user_id, episode_id, watched_at)
         SELECT ?1, e.id, ?3 FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
         WHERE e.show_id = ?2 AND ${cond(5)}
           AND ${airedCond("?4", "sh")}
           AND NOT EXISTS (SELECT 1 FROM user_episodes ue WHERE ue.user_id = ?1 AND ue.episode_id = e.id)
         ON CONFLICT DO NOTHING`
      ).bind(uid, showId, ts, today, ...binds)
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO user_episodes (user_id, episode_id, watched_at)
       SELECT ?1, e.id, ?3 FROM episodes e JOIN shows sh ON sh.tmdb_id = e.show_id
       WHERE e.show_id = ?2 AND ${cond(5)}
         AND ${airedCond("?4", "sh")}
       ON CONFLICT (user_id, episode_id) DO NOTHING`
    ).bind(uid, showId, ts, today, ...binds)
  );
  await c.env.DB.batch(stmts);

  if (round && (await completeRoundIfDone(c, uid, showId, round.round, round.started_at))) {
    return { roundComplete: true, round: round.round };
  }
  return { roundComplete: false };
}

// Bulk watch responses carry roundComplete/round when the sweep just closed
// an active rewatch round — the same flag the single-episode route ships.
const bulkJson = (r: { roundComplete: boolean; round?: number }) => ({
  ok: true,
  ...(r.roundComplete ? { roundComplete: true, round: r.round } : {}),
});

library.post("/shows/:id/seasons/:num/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const num = Number(c.req.param("num"));
  if (!id || !Number.isInteger(num) || num < 0) return c.json({ error: "bad request" }, 400);
  return c.json(bulkJson(await bulkWatch(c, id, { season: num }, false)));
});

library.delete("/shows/:id/seasons/:num/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const num = Number(c.req.param("num"));
  if (!id || !Number.isInteger(num) || num < 0) return c.json({ error: "bad request" }, 400);
  // Scoped by the caller, like the single-episode un-tick — this route is
  // queued offline too, so the season's whole history must not hinge on what
  // the round state looks like whenever the replay lands.
  const body = await c.req.json().catch(() => ({}));
  const raw = String((body as any)?.scope ?? "");
  await bulkWatch(c, id, { season: num }, true, raw === "round" || raw === "all" ? raw : null);
  return c.json({ ok: true });
});

library.post("/shows/:id/watch-all", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  return c.json(bulkJson(await bulkWatch(c, id, {}, false)));
});

// Catch-up: mark everything up to and including SxxEyy watched, one call.
// Regular seasons only — specials (season 0) are never swept in (scopeSql's
// until predicate keeps the explicit season_number > 0 guard).
library.post("/shows/:id/watch-until", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const season = Number(body.season);
  const number = Number(body.number);
  if (!id || !Number.isInteger(season) || season < 1 || !Number.isInteger(number) || number < 1)
    return c.json({ error: "bad request" }, 400);
  return c.json(bulkJson(await bulkWatch(c, id, { until: { season, number } }, false)));
});

// ---------- Movies ----------

library.post("/movies/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  const watchedAt = watchedAtFrom(await c.req.json().catch(() => ({})));
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  await ensureMovie(c.env, id);
  // The WHERE mirrors the episode-watch upsert: an exact replay
  // of an already-recorded mark (same watched_at) is a no-op so offline-queue
  // retries can't inflate play_count; genuine rewatches carry a fresh
  // timestamp and still count. It asks user_movie_plays — the 0043 source of
  // truth — not user_movies.watched_at, which only ever holds the LATEST
  // watch: a replay of any earlier dated play used to pass the check and bump
  // play_count with no play row behind it, which the movie page then printed
  // as an undated legacy play. The statement runs before the play insert
  // below in the same batch, so it sees the pre-existing plays only.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO user_movies (user_id, movie_id, state, watched_at, play_count, added_at) VALUES (?1, ?2, 'watched', ?3, 1, ?4)
       ON CONFLICT (user_id, movie_id) DO UPDATE
         SET state = 'watched', play_count = user_movies.play_count + 1,
             watched_at = MAX(COALESCE(user_movies.watched_at, excluded.watched_at), excluded.watched_at)
         WHERE user_movies.state != 'watched'
            OR NOT EXISTS (SELECT 1 FROM user_movie_plays p
                           WHERE p.user_id = ?1 AND p.movie_id = ?2 AND p.watched_at = ?3)`
    ).bind(c.get("uid"), id, watchedAt, nowIso()),
    c.env.DB.prepare(
      "INSERT INTO user_movie_plays (user_id, movie_id, watched_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING"
    ).bind(c.get("uid"), id, watchedAt),
  ]);
  // Notify followers, off the response path — see the episode
  // watch route above for the reasoning.
  c.executionCtx.waitUntil(
    notifyFollowersOfWatch(c.env, c.get("uid"), "movie", id).catch((e) => console.error("notify failed", e))
  );
  return c.json({ ok: true });
});

library.delete("/movies/:id/watch", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  // Full unwatch: the row goes, and its dated plays go with it — the same
  // pairing as the episode unwatch outside a round.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM user_movie_plays WHERE user_id = ?1 AND movie_id = ?2").bind(c.get("uid"), id),
    c.env.DB.prepare("DELETE FROM user_movies WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watched'").bind(
      c.get("uid"),
      id
    ),
  ]);
  return c.json({ ok: true });
});

// Remove ONE dated movie play — the Watch history rows' remove button on the
// movie page, mirroring DELETE /episodes/:id/plays. Removing the last play
// is the existing unwatch (row deleted); otherwise play_count steps back and
// watched_at snaps to the latest remaining play (the column the watch upsert
// keeps at the most recent watch).
library.delete("/movies/:id/plays", async (c) => {
  const id = intParam(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const t = Date.parse(String(body?.watched_at ?? ""));
  const watchedAt = Number.isNaN(t) ? null : new Date(t).toISOString();
  if (!id || !watchedAt) return c.json({ error: "bad request" }, 400);
  const uid = c.get("uid");

  const del = await c.env.DB.prepare("DELETE FROM user_movie_plays WHERE user_id = ?1 AND movie_id = ?2 AND watched_at = ?3")
    .bind(uid, id, watchedAt)
    .run();
  if ((del.meta.changes ?? 0) === 0) return c.json({ ok: true }); // already gone — idempotent

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE user_movies SET play_count = MAX(play_count - 1, 1),
         watched_at = COALESCE((SELECT MAX(p.watched_at) FROM user_movie_plays p
                                WHERE p.user_id = ?1 AND p.movie_id = ?2), watched_at)
       WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watched'`
    ).bind(uid, id),
    c.env.DB.prepare(
      `DELETE FROM user_movies WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watched'
         AND NOT EXISTS (SELECT 1 FROM user_movie_plays p WHERE p.user_id = ?1 AND p.movie_id = ?2)`
    ).bind(uid, id),
  ]);
  return c.json({ ok: true });
});

library.put("/movies/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await ensureMovie(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO user_movies (user_id, movie_id, state, play_count, added_at) VALUES (?1, ?2, 'watchlist', 0, ?3)
     ON CONFLICT (user_id, movie_id) DO NOTHING`
  )
    .bind(c.get("uid"), id, nowIso())
    .run();
  return c.json({ ok: true });
});

library.delete("/movies/:id/watchlist", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM user_movies WHERE user_id = ?1 AND movie_id = ?2 AND state = 'watchlist'")
    .bind(c.get("uid"), id)
    .run();
  return c.json({ ok: true });
});
