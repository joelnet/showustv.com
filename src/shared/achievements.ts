// Achievement catalog (issue #19). The single source of truth for what
// exists: the worker awards against these ids (lib/achievements.ts decides
// when), the web renders titles/emoji/hints from here, and the DB stores
// only (user, id, unlocked_at) rows. Adding an achievement = add it here
// plus its check in the worker; existing users earn it on their next action.

export interface Achievement {
  id: string;
  emoji: string;
  title: string;
  desc: string; // shown as the locked-state hint too — phrase as the goal
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  // ---- Comments ----
  { id: "first-words", emoji: "🎤", title: "First Words", desc: "Post your first comment" },
  { id: "chatterbox", emoji: "💬", title: "Chatterbox", desc: "Post 10 comments" },
  { id: "town-crier", emoji: "📢", title: "Town Crier", desc: "Post 50 comments" },
  { id: "scene-stealer", emoji: "🎬", title: "Scene Stealer", desc: "Comment on an episode" },
  { id: "series-regular", emoji: "📺", title: "Series Regular", desc: "Comment on a show" },
  { id: "film-critic", emoji: "🍿", title: "Film Critic", desc: "Comment on a movie" },
  { id: "deep-cuts", emoji: "🕰️", title: "Deep Cuts", desc: "Comment on a show that premiered 10+ years ago" },
  { id: "thread-starter", emoji: "🧵", title: "Thread Starter", desc: "Get 5 replies to one of your comments" },
  { id: "crowd-pleaser", emoji: "👏", title: "Crowd Pleaser", desc: "Get a comment to +10" },
  { id: "second-thoughts", emoji: "✏️", title: "Second Thoughts", desc: "Edit a comment" },

  // ---- Watching TV ----
  { id: "first-light", emoji: "🌱", title: "First Light", desc: "Mark your first episode watched" },
  { id: "century-club", emoji: "💯", title: "Century Club", desc: "Watch 100 episodes" },
  { id: "kilowatcher", emoji: "⚡", title: "Kilowatcher", desc: "Watch 1,000 episodes" },
  { id: "hundred-hours", emoji: "⏰", title: "The Hundred-Hour Club", desc: "Watch 100 hours of TV" },
  { id: "time-lord", emoji: "⌛", title: "Time Lord", desc: "Watch 1,000 hours of TV" },
  { id: "roll-credits", emoji: "🏁", title: "Roll Credits", desc: "Watch every aired episode of an ended show" },
  { id: "pilot-season", emoji: "✈️", title: "Pilot Season", desc: "Watch the pilot of 10 different shows" },
  { id: "deja-view", emoji: "🔁", title: "Déjà View", desc: "Rewatch an episode" },

  // ---- Movies ----
  { id: "movie-night", emoji: "🎥", title: "Movie Night", desc: "Watch your first movie" },
  { id: "double-feature", emoji: "🎞️", title: "Double Feature", desc: "Watch two movies in one day" },
  { id: "popcorn-century", emoji: "🥤", title: "Popcorn Century", desc: "Watch 100 movies" },

  // ---- Ratings & reactions ----
  { id: "star-grader", emoji: "⭐", title: "Star Grader", desc: "Rate 50 titles" },
  { id: "full-range", emoji: "🎭", title: "Full Range", desc: "Hand out both a 1 and a 10" },
  { id: "speaks-in-emoji", emoji: "😂", title: "Speaks in Emoji", desc: "Leave an emoji reaction" },

  // ---- Library & social ----
  { id: "packed-lineup", emoji: "🗓️", title: "Packed Lineup", desc: "Follow 25 shows" },
  { id: "vintage-collector", emoji: "📼", title: "Vintage Collector", desc: "Follow a show that premiered before 1990" },
  { id: "curator", emoji: "🗂️", title: "Curator", desc: "Build a list with 10 titles" },
  { id: "open-curtains", emoji: "🌐", title: "Open Curtains", desc: "Make your profile public" },
  { id: "card-carrying", emoji: "🪪", title: "Card-Carrying Member", desc: "Verify your email" },
  { id: "better-together", emoji: "🤝", title: "Better Together", desc: "Follow your first person" },
  { id: "entourage", emoji: "👥", title: "Entourage", desc: "Follow 10 people" },
] as const;

export const ACHIEVEMENTS_BY_ID: ReadonlyMap<string, Achievement> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
