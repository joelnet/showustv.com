// The reaction set for "From People You Follow" activity (#20) — the
// Facebook-familiar five, in picker order. Distinct from EMOJI_REACTIONS in
// constants.ts (the TV Time-style emotion a user pins on their OWN rating):
// these are social — one user reacting to another user's watch activity.
// Shared so the worker's validation, the tile picker, and the notification
// rendering all agree on the set; the CHECK constraint in 0040 mirrors it.
export const REACTION_TYPES = ["like", "love", "laugh", "wow", "sad"] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export const REACTION_EMOJI: Record<ReactionType, string> = {
  like: "👍",
  love: "❤️",
  laugh: "😂",
  wow: "😮",
  sad: "😢",
};

// Accessible names for the picker options — Facebook's wording where it's
// the familiar one ("Haha", not "Laugh").
export const REACTION_LABELS: Record<ReactionType, string> = {
  like: "Like",
  love: "Love",
  laugh: "Haha",
  wow: "Wow",
  sad: "Sad",
};
