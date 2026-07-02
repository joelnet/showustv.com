// Fixed emoji-reaction set for episodes/shows/movies (TV Time-style emotions).
export const EMOJI_REACTIONS = ["❤️", "😂", "🤯", "😢", "😐", "👎"] as const;

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
