// Unauthenticated read-only endpoints. Mounted BEFORE the auth middleware —
// only explicitly shared content may ever be served here.
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { statsQuery, statsFromRow } from "../lib/stats";
import { readSession } from "../lib/session";
import { libraryPayload, animeCond } from "../lib/library";

export const pub = new Hono<AppEnv>();

interface ProfileOwner {
  id: number;
  username: string;
  profile_public: number;
  activity_public: number;
  shadow_banned: number;
}
type ProfileGate =
  | { kind: "missing" }
  | { kind: "teaser"; user: ProfileOwner }
  | { kind: "full"; user: ProfileOwner; viewer: Awaited<ReturnType<typeof readSession>> };

// The one visibility gate for every /u/:username surface served here — the
// profile and the public library (issue #245) must agree on who sees what,
// so they share this decision. A private profile answers with an
// Instagram-style teaser — the canonical username and `private: true`,
// nothing else — so the page can say "this profile is private" instead of
// pretending the person doesn't exist. Only a genuinely unknown (or deleted)
// username reads as missing (404). Two viewers still get the full content of
// a private account: the owner, and a MUTUAL follow (issue #184) — the owner
// following the viewer back is a deliberate signal that they want to be
// seen. A one-way follow never unlocks anything: follows are instant and
// unapproved, so a viewer could self-grant one (that's why issue #158 kept
// followers out).
//
// The teaser (issue #158) must never carry the private content — no stats,
// lists, achievements, comments, counts, or watch history. The mutual check
// demands BOTH directions be active in a single self-join: `f` is
// viewer→owner, `r` is owner→viewer. The owner's row already proved them
// not-deleted; the users join re-checks the viewer, since sessions are
// stateless HMAC cookies that can outlive a soft-deleted account.
async function profileGate(c: Context<AppEnv>, username: string): Promise<ProfileGate> {
  const user = await c.env.DB.prepare(
    "SELECT id, username, profile_public, activity_public, shadow_banned FROM users WHERE username = ?1 AND deleted_at IS NULL"
  )
    .bind(username)
    .first<ProfileOwner>();
  if (!user) return { kind: "missing" };

  const viewer = await readSession(c);

  if (!user.profile_public && viewer?.u !== user.id) {
    const mutual =
      viewer &&
      (await c.env.DB.prepare(
        `SELECT 1 FROM follows f
         JOIN follows r ON r.follower_id = f.followee_id AND r.followee_id = f.follower_id AND r.state = 'active'
         JOIN users v ON v.id = f.follower_id AND v.deleted_at IS NULL
         WHERE f.follower_id = ?1 AND f.followee_id = ?2 AND f.state = 'active'`
      )
        .bind(viewer.u, user.id)
        .first());
    if (!mutual) return { kind: "teaser", user };
  }
  return { kind: "full", user, viewer };
}

// Watch-history rows for the profile (issue #245): at most this many tiles
// per row. Each query LIMITs to it directly; only the Anime row — a merge of
// anime shows and anime movies — re-trims after combining.
const HISTORY_ROW_LIMIT = 20;

// One show tile per SHOW — its latest-watched episode (see the batch comment
// in the profile route for why ROW_NUMBER and why the split is in SQL).
function historyShowsStmt(c: Context<AppEnv>, uid: number, anime: boolean): D1PreparedStatement {
  return c.env.DB.prepare(
    `SELECT id, title, poster, backdrop, still, season, number, episode_title, ts FROM (
       SELECT w.*, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC, season DESC, number DESC) AS rn
       FROM (
         SELECT e.show_id AS id, s.title, s.poster_url AS poster, s.backdrop_url AS backdrop,
                e.still_url AS still, e.season_number AS season, e.number, e.title AS episode_title,
                CASE WHEN ue.last_rewatched_at > ue.watched_at THEN ue.last_rewatched_at ELSE ue.watched_at END AS ts
         FROM user_episodes ue
         JOIN episodes e ON e.id = ue.episode_id
         JOIN shows s ON s.tmdb_id = e.show_id
         WHERE ue.user_id = ?1 AND e.season_number > 0
           AND ${anime ? "" : "NOT "}${animeCond("s")}
           AND NOT EXISTS (SELECT 1 FROM user_shows h
                           WHERE h.user_id = ?1 AND h.show_id = e.show_id AND h.state = 'hidden')
       ) w
     ) WHERE rn = 1 ORDER BY ts DESC LIMIT ${HISTORY_ROW_LIMIT}`
  ).bind(uid);
}

function historyMoviesStmt(c: Context<AppEnv>, uid: number, anime: boolean): D1PreparedStatement {
  return c.env.DB.prepare(
    `SELECT m.tmdb_id AS id, m.title, m.poster_url AS poster, um.watched_at AS ts
     FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
     WHERE um.user_id = ?1 AND um.state = 'watched' AND um.watched_at IS NOT NULL
       AND ${anime ? "" : "NOT "}${animeCond("m")}
     ORDER BY um.watched_at DESC LIMIT ${HISTORY_ROW_LIMIT}`
  ).bind(uid);
}

// Public profile at /u/:username — visibility decided by profileGate above.
// Of the lists, only those BOTH pinned to the profile AND individually
// shared are served — a pinned private list stays private.
pub.get("/profile/:username", async (c) => {
  const gate = await profileGate(c, c.req.param("username"));
  if (gate.kind === "missing") return c.json({ error: "not found" }, 404);
  if (gate.kind === "teaser") return c.json({ username: gate.user.username, private: true });
  const { user, viewer } = gate;

  // Recent activity (issue #202): the 20 most recent things this user did,
  // derived at read time from the library/ratings tables — no event log to
  // backfill. The owner can hide the section (users.activity_public); the
  // gate is server-side, and the query doesn't even run for a hidden
  // section, so nothing can leak past a client bug. The owner always gets
  // their own activity — the eye toggle needs something to stand next to.
  // Each branch is pre-trimmed to 20 before the UNION so a decade of watch
  // history doesn't get sorted whole on every profile view.
  const isOwner = viewer?.u === user.id;
  const wantActivity = !!user.activity_public || isOwner;
  const statements = [
    statsQuery(c.env.DB, user.id),
    c.env.DB.prepare(
      `SELECT l.id, l.name, COUNT(li.list_id) AS count
       FROM custom_lists l LEFT JOIN custom_list_items li ON li.list_id = l.id
       WHERE l.user_id = ?1 AND l.profile_position IS NOT NULL AND l.is_shared = 1
       GROUP BY l.id ORDER BY l.profile_position`
    ).bind(user.id),
    // Collage: the first 4 items with a poster per list, trimmed in SQL so
    // large lists don't ship every row to the Worker.
    c.env.DB.prepare(
      `SELECT list_id, poster FROM (
         SELECT li.list_id, COALESCE(s.poster_url, m.poster_url) AS poster,
                ROW_NUMBER() OVER (PARTITION BY li.list_id ORDER BY li.position) AS rn
         FROM custom_list_items li
         JOIN custom_lists l ON l.id = li.list_id
           AND l.user_id = ?1 AND l.profile_position IS NOT NULL AND l.is_shared = 1
         LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
         LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
         WHERE COALESCE(s.poster_url, m.poster_url) IS NOT NULL
       ) WHERE rn <= 4 ORDER BY list_id, rn`
    ).bind(user.id),
    // Comment activity (issue #16): which shows this user is talking about.
    // Episode comments surface their show's title — that's the conversation
    // a visitor cares about. Deleted comments never appear, and rows whose
    // catalog target vanished are dropped here, not client-side.
    c.env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.target_type, c.target_id,
              COALESCE(s.title, m.title, es.title) AS title,
              e.season_number AS season, e.number AS episode, e.title AS episode_title
       FROM comments c
       LEFT JOIN shows s ON c.target_type = 'show' AND s.tmdb_id = c.target_id
       LEFT JOIN movies m ON c.target_type = 'movie' AND m.tmdb_id = c.target_id
       LEFT JOIN episodes e ON c.target_type = 'episode' AND e.id = c.target_id
       LEFT JOIN shows es ON es.tmdb_id = e.show_id
       WHERE c.user_id = ?1 AND c.deleted_at IS NULL
         AND COALESCE(s.title, m.title, es.title) IS NOT NULL
       ORDER BY c.created_at DESC LIMIT 15`
    ).bind(user.id),
    c.env.DB.prepare("SELECT achievement_id FROM user_achievements WHERE user_id = ?1 ORDER BY unlocked_at").bind(user.id),
    // Watch-history rows (issue #245): Shows / Movies / Anime tile rows above
    // the achievements, straight from the history tables. Shows are deduped
    // to ONE row per show — the latest-watched episode — so a binge can't
    // flood the row; ROW_NUMBER (the friends-watched pattern in
    // routes/library.ts) rather than GROUP BY+MAX because bulk mark-watched
    // stamps many episodes with one timestamp, and among those ties the
    // furthest episode — the user's actual progress point — must win, not an
    // arbitrary row. The anime split happens IN the query (animeCond, the
    // SQL twin of shared isAnime) so each row gets its own LIMIT — filtering
    // after one shared LIMIT would let a recent anime binge starve the Shows
    // row of older non-anime history, and vice versa. Specials (season 0)
    // and hidden shows stay out, mirroring the activity feed above. No
    // separate visibility toggle: these run only after profileGate served
    // the full profile, so they're exactly as visible as the profile itself.
    historyShowsStmt(c, user.id, false),
    historyMoviesStmt(c, user.id, false),
    historyShowsStmt(c, user.id, true),
    historyMoviesStmt(c, user.id, true),
  ];
  if (wantActivity)
    statements.push(
      // Kinds mirror what the client can phrase: 'show_added' ("started
      // following") vs 'show_saved' (watch later) comes from the row's
      // current state — added_at doesn't record which one it was, and the
      // current state is the truthful label for what's on the shelf now.
      // Hidden shows stay hidden in every branch — the follow row itself,
      // watched episodes of the show, and ratings of the show or its
      // episodes. Movie watchlist adds have no timestamp
      // (user_movies.watched_at is NULL until watched), so they can't
      // appear. Rated rows join their heterogeneous target the same way the
      // comments query above does, and drop rows whose catalog target
      // vanished. Episode rows carry the show title; the episode's own title
      // rides in episode_title for the link slug.
      c.env.DB.prepare(
        `SELECT kind, ts, type, id, title, season, episode, episode_title, score FROM (
           SELECT * FROM (
             SELECT CASE WHEN us.state = 'watch_later' THEN 'show_saved' ELSE 'show_added' END AS kind,
                    us.added_at AS ts, 'show' AS type, s.tmdb_id AS id, s.title AS title,
                    NULL AS season, NULL AS episode, NULL AS episode_title, NULL AS score
             FROM user_shows us JOIN shows s ON s.tmdb_id = us.show_id
             WHERE us.user_id = ?1 AND us.state != 'hidden'
             ORDER BY us.added_at DESC LIMIT 20)
           UNION ALL
           SELECT * FROM (
             SELECT 'episode_watched', ue.watched_at, 'episode', e.id, sh.title,
                    e.season_number, e.number, e.title, NULL
             FROM user_episodes ue
             JOIN episodes e ON e.id = ue.episode_id
             JOIN shows sh ON sh.tmdb_id = e.show_id
             WHERE ue.user_id = ?1
               AND NOT EXISTS (SELECT 1 FROM user_shows h
                               WHERE h.user_id = ?1 AND h.show_id = e.show_id AND h.state = 'hidden')
             ORDER BY ue.watched_at DESC LIMIT 20)
           UNION ALL
           SELECT * FROM (
             SELECT 'movie_watched', um.watched_at, 'movie', m.tmdb_id, m.title,
                    NULL, NULL, NULL, NULL
             FROM user_movies um JOIN movies m ON m.tmdb_id = um.movie_id
             WHERE um.user_id = ?1 AND um.state = 'watched' AND um.watched_at IS NOT NULL
             ORDER BY um.watched_at DESC LIMIT 20)
           UNION ALL
           SELECT * FROM (
             SELECT 'rated', r.created_at, r.target_type, r.target_id,
                    COALESCE(s2.title, m2.title, es2.title),
                    e2.season_number, e2.number, e2.title, r.score
             FROM ratings r
             LEFT JOIN shows s2 ON r.target_type = 'show' AND s2.tmdb_id = r.target_id
             LEFT JOIN movies m2 ON r.target_type = 'movie' AND m2.tmdb_id = r.target_id
             LEFT JOIN episodes e2 ON r.target_type = 'episode' AND e2.id = r.target_id
             LEFT JOIN shows es2 ON es2.tmdb_id = e2.show_id
             WHERE r.user_id = ?1 AND r.score IS NOT NULL
               AND COALESCE(s2.title, m2.title, es2.title) IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM user_shows h
                               WHERE h.user_id = ?1 AND h.show_id = COALESCE(s2.tmdb_id, es2.tmdb_id)
                                 AND h.state = 'hidden')
             ORDER BY r.created_at DESC LIMIT 20)
         ) ORDER BY ts DESC LIMIT 20`
      ).bind(user.id)
    );
  const [statsR, listsR, postersR, commentsR, achR, histShowsR, histMoviesR, histAnimeShowsR, histAnimeMoviesR, activityR] =
    await c.env.DB.batch(statements);

  // The items are TileItem-shaped (components/tiles.tsx) so the client
  // renders them with the Watch Now tiles verbatim. Anime shows and movies
  // share one row, merged by recency and re-trimmed to the row cap.
  const showTile = (r: any) => ({
    kind: "show" as const,
    id: r.id,
    title: r.title,
    poster: r.poster,
    backdrop: r.backdrop,
    still: r.still,
    season: r.season,
    number: r.number,
    episodeTitle: r.episode_title,
  });
  const movieTile = (r: any) => ({ kind: "movie" as const, id: r.id, title: r.title, poster: r.poster, backdrop: null, still: null });
  const historyAnime = [
    ...(histAnimeShowsR.results as any[]).map((r) => ({ ts: r.ts as string, item: showTile(r) })),
    ...(histAnimeMoviesR.results as any[]).map((r) => ({ ts: r.ts as string, item: movieTile(r) })),
  ]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, HISTORY_ROW_LIMIT)
    .map((a) => a.item);

  // Comment bodies are a signed-in surface (thread pages sit behind auth,
  // and episode snippets are spoiler-prone) — anonymous visitors get the
  // conversation metadata only: title, episode slate, when.
  const signedIn = !!viewer;
  // Shadow ban (issue #18): the banned user still sees their own
  // conversations here; everyone else sees none — same invisibility their
  // comments get on thread pages, so the profile can't out the ban.
  const hideComments = !!user.shadow_banned && viewer?.u !== user.id;

  const posters = new Map<number, string[]>();
  for (const r of postersR.results as any[]) {
    const arr = posters.get(r.list_id) ?? [];
    arr.push(r.poster);
    posters.set(r.list_id, arr);
  }
  // A private profile served in full — to its owner or to a mutual follow —
  // is personal content on a public, viewer-varying URL — no-store keeps it
  // out of the service worker's API cache (sw.js honors this), so it can't
  // be replayed to a later, unauthenticated or non-mutual visitor on the
  // same browser. The owner viewing their own hidden activity on an
  // otherwise-public profile is the same trap: that payload carries content
  // every other viewer is denied, so it must not be cached either.
  if (!user.profile_public || (isOwner && !user.activity_public)) c.header("Cache-Control", "no-store");
  return c.json({
    username: user.username,
    // True only when a private profile is served in full: to its owner, or
    // to a mutual follow (issue #184) — every other viewer got the teaser
    // above. The page uses it to suppress the share button and explain why
    // the viewer can see the page.
    private: !user.profile_public,
    stats: statsFromRow(statsR.results[0]),
    lists: (listsR.results as any[]).map((l) => ({ ...l, posters: posters.get(l.id) ?? [] })),
    achievements: (achR.results as any[]).map((r) => r.achievement_id),
    // The Shows / Movies / Anime history rows (issue #245) — visible exactly
    // when the profile is (no per-section toggle), deduped and split above.
    history: {
      shows: (histShowsR.results as any[]).map(showTile),
      movies: (histMoviesR.results as any[]).map(movieTile),
      anime: historyAnime,
    },
    // Empty when the owner hid the section — indistinguishable from a user
    // with nothing to show, so the hidden preference itself isn't
    // advertised. `activityPublic` rides along for the owner alone: it
    // drives their eye toggle, and its absence is how the page knows not to
    // render one for anybody else.
    activity: (wantActivity ? (activityR!.results as any[]) : []).map((r) => ({
      kind: r.kind,
      ts: r.ts,
      score: r.score,
      target: {
        type: r.type,
        id: r.id,
        title: r.title,
        season: r.season,
        episode: r.episode,
        episodeTitle: r.episode_title,
      },
    })),
    ...(isOwner ? { activityPublic: !!user.activity_public } : {}),
    comments: (hideComments ? [] : (commentsR.results as any[])).map((r) => ({
      // Snippet only — profiles tease the conversation, the thread holds it.
      body: signedIn ? (r.body.length > 240 ? r.body.slice(0, 239) + "…" : r.body) : null,
      createdAt: r.created_at,
      target: {
        type: r.target_type,
        id: r.target_id,
        title: r.title,
        season: r.season,
        episode: r.episode,
        episodeTitle: r.episode_title,
      },
    })),
  });
});

// The public library at /u/:username/library (issue #245): the same payload
// the owner's authed GET /library serves — one shared query path in
// lib/library.ts — but for the named user, read-only by nature (this router
// is GET-only and unauthenticated). Gated by profileGate exactly like the
// profile: a private profile serves the same teaser here, so the library can
// never leak what the profile hides — there is deliberately NO separate
// visibility toggle for it. The watchlist is just as deliberately absent:
// it's private planning, shown on no public surface.
pub.get("/library/:username", async (c) => {
  const gate = await profileGate(c, c.req.param("username"));
  if (gate.kind === "missing") return c.json({ error: "not found" }, 404);
  if (gate.kind === "teaser") return c.json({ username: gate.user.username, private: true });
  const { user, viewer } = gate;

  // "Today" (for aired counts / staleness) is timezone-shaped: the signed-in
  // viewer's own tz, UTC for anonymous visitors.
  const payload = await libraryPayload(c.env.DB, user.id, viewer?.tz ?? "UTC");

  // Same cache hygiene as the profile: a private library served in full — to
  // its owner or a mutual (issue #184) — is personal content on a public,
  // viewer-varying URL; no-store keeps it out of the service worker's API
  // cache so it can't replay to a later non-mutual visitor on this browser.
  if (!user.profile_public) c.header("Cache-Control", "no-store");
  return c.json({ username: user.username, private: !user.profile_public, ...payload });
});

pub.get("/lists/:username/:id", async (c) => {
  const username = c.req.param("username");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "not found" }, 404);

  const meta = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.preamble, l.comments_enabled, u.username
     FROM custom_lists l JOIN users u ON u.id = l.user_id
     WHERE l.id = ?1 AND u.username = ?2 AND l.is_shared = 1 AND u.deleted_at IS NULL`
  )
    .bind(id, username)
    .first();
  if (!meta) return c.json({ error: "not found" }, 404);

  const { results: items } = await c.env.DB.prepare(
    `SELECT li.target_type AS type, li.target_id AS id,
            COALESCE(s.title, m.title) AS title, COALESCE(s.poster_url, m.poster_url) AS poster,
            COALESCE(s.overview, m.overview) AS overview
     FROM custom_list_items li
     LEFT JOIN shows s ON li.target_type = 'show' AND s.tmdb_id = li.target_id
     LEFT JOIN movies m ON li.target_type = 'movie' AND m.tmdb_id = li.target_id
     WHERE li.list_id = ?1 ORDER BY li.position`
  )
    .bind(id)
    .all();

  return c.json({
    list: {
      id: meta.id,
      name: meta.name,
      preamble: meta.preamble ?? null,
      username: meta.username,
      commentsEnabled: !!meta.comments_enabled,
    },
    items,
  });
});
