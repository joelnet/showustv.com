// Anime classification, shared by shows and movies. A title is
// treated as anime when it's animated *and* Japanese in origin: the genre list
// includes "Animation" and the original language is Japanese ("ja"). TMDB
// exposes the same `genres` + `original_language` fields on both the /tv and
// /movie objects, so one helper classifies either. Japanese-only for now.
// worker/lib/library.ts animeCond() is this same test in SQL (for queries
// that must LIMIT per section) — change one, change both.
export function isAnime(
  genres: readonly string[] | null | undefined,
  originalLanguage: string | null | undefined
): boolean {
  return originalLanguage === "ja" && !!genres?.some((g) => g === "Animation");
}
