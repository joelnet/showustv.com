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
