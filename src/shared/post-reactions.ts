// Emoji reactions on feed posts (the Instagram-style /feed). One reaction per
// viewer per post: the quick row is what the card shows inline, the "+"
// button opens the full curated grid. The server validates against
// POST_REACTION_SET, so the client only ever sends these exact strings —
// that keeps variation selectors (❤️ is U+2764 U+FE0F) byte-identical between
// what's stored, grouped, and rendered.

export const POST_REACTION_QUICK = ["❤️", "😂", "😮", "😢", "🔥", "👍"] as const;

export const POST_REACTION_ALL = [
  ...POST_REACTION_QUICK,
  "😍", "🥰", "🤣", "😭", "🥹", "😅", "😬", "🙄", "😴", "🤔",
  "🤯", "😱", "😨", "😏", "😎", "🥳", "😇", "🤩", "😳", "🥲",
  "😤", "🤮", "🤡", "💀", "👀", "🍿", "📺", "🎬", "🎉", "👏",
  "🙌", "🤝", "💯", "✨", "⭐", "🏆", "🎯", "💔", "🖤", "💜",
  "💙", "💚", "💛", "🧡", "🤍", "👎", "🤌", "🫶", "🫡", "🤷",
  "🫠", "💩", "🙏", "😐", "🤨", "😪", "🫣", "🥶",
] as const;

export type PostReaction = (typeof POST_REACTION_ALL)[number];

export const POST_REACTION_SET: ReadonlySet<string> = new Set(POST_REACTION_ALL);
