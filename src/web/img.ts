// TMDB images are hotlinked (never proxied or stored) per TMDB terms + cost plan.
const BASE = "https://image.tmdb.org/t/p";

export const poster = (path: string | null, size: "w154" | "w342" | "w500" = "w342") =>
  path ? `${BASE}/${size}${path}` : null;
export const backdrop = (path: string | null) => (path ? `${BASE}/w1280${path}` : null);
export const still = (path: string | null) => (path ? `${BASE}/w300${path}` : null);
export const providerLogo = (path: string | null) => (path ? `${BASE}/w92${path}` : null);
