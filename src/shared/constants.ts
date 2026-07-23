// Fixed emoji-reaction set for episodes/shows/movies (TV Time-style emotions).
export const EMOJI_REACTIONS = ["❤️", "😂", "🤯", "😢", "😐", "👎"] as const;

// ---------- Comments ----------

export const COMMENT_MAX_LEN = 2000;

// Links are banned in comments (spam control). Catches protocols, www., and
// bare domains on common TLDs; deliberately not adversary-proof — the target
// is ordinary users pasting links, and the worker re-checks every write.
// Shared so the composer can reject before a round trip.
export const COMMENT_URL_RE =
  /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|tv|me|gg|ly|app|dev|xyz|info|site|online|to)(?=\/|\b)/i;

// ---------- TMDB cache policy ----------

// TMDB api-terms-of-use §1.C: data obtained from the TMDB API may not be
// cached longer than 6 months, commercial or not. Shared (issue #1) so the
// Worker's nightly ToS sweep (src/worker/index.ts, which refreshes D1 rows a
// month EARLY to stay comfortably inside the cap) and the device-side
// precache freshness window (src/web/precache.ts) derive from the same
// number instead of drifting apart as independent literals.
export const TMDB_CACHE_POLICY_DAYS = 180; // ~6 months

// A followed show counts as "recently active" while it was watched — or had an
// episode air — within this many days. Recently-active shows fill Watch Next's
// main queue; the rest drop to its "Haven't watched for a while" section. (The
// Library's Watching tab ignores recency — issue #253.) Tune this one number
// to widen or tighten the split.
export const RECENT_WINDOW_DAYS = 90;

// States stored in user_shows.state. up_to_date/finished/not_started are
// derived from watch data at read time, never written.
export const STORED_SHOW_STATES = ["watching", "stopped", "watch_later"] as const;

export type DerivedShowState =
  | "watching"
  | "up_to_date"
  | "finished"
  | "not_started"
  | "stopped"
  | "watch_later";
