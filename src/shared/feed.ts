// Shapes and formatting shared by the feed API (routes/feed.ts) and the feed
// pages (pages/feed.tsx, components/post-card.tsx), plus the caption text the
// push notifications reuse (lib/notifications.ts).

export interface FeedEpisodeRef {
  season: number;
  number: number;
}

export interface FeedPost {
  id: number;
  username: string;
  mine: boolean;
  kind: "show" | "movie";
  targetId: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  firstAt: string;
  lastAt: string;
  rewatch: boolean;
  // Every episode in the post, ordered by season then number. Empty for movies.
  episodes: FeedEpisodeRef[];
  // The most recently watched episode: its still is the card's image.
  latestEpisode: { id: number; season: number; number: number; title: string | null; still: string | null } | null;
  // Distinct emoji with counts, most popular first.
  reactions: { emoji: string; count: number }[];
  myReaction: string | null;
  commentCount: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

// The episode span of a post, Instagram-caption style: contiguous runs within
// a season collapse to a range, stragglers list individually, seasons are
// separated by " · ". "S02·E05–E07", "S01·E09, E10 · S02·E01". Past six
// episodes the exact list stops being readable and becomes a count.
export function episodeRangeText(episodes: FeedEpisodeRef[]): string {
  if (!episodes.length) return "";
  if (episodes.length > 6) return `${episodes.length} episodes`;
  const bySeason = new Map<number, number[]>();
  for (const e of episodes) {
    const list = bySeason.get(e.season) ?? [];
    list.push(e.number);
    bySeason.set(e.season, list);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  return seasons
    .map((s) => {
      const nums = [...new Set(bySeason.get(s)!)].sort((a, b) => a - b);
      const runs: string[] = [];
      let i = 0;
      while (i < nums.length) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        runs.push(j > i ? `E${pad(nums[i])}–E${pad(nums[j])}` : `E${pad(nums[i])}`);
        i = j + 1;
      }
      return `S${pad(s)}·${runs.join(", ")}`;
    })
    .join(" · ");
}
