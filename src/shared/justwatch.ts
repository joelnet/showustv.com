// JustWatch title-search URL for the streaming shelf (issue #310). TMDB's
// watch-provider data is sourced from JustWatch, but TMDB only exposes its own
// watch-page URL (which just redirects to JustWatch), so we send users straight
// to JustWatch's search for the title. Region defaults to "us", matching the
// worker's US-only provider fetch (see worker/lib/tmdb.ts watchProviders).
export function justWatchSearchUrl(title: string, region = "us"): string {
  return `https://www.justwatch.com/${region}/search?q=${encodeURIComponent(title)}`;
}
