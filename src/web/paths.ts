// SEO-friendly detail URLs: /show/1405-dexter instead of /show/1405. Only
// the numeric prefix identifies the record — the slug is advisory, so stale
// or missing slugs still resolve and the pages canonicalize the address bar.

export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics: "Pokémon" → "pokemon"
    .toLowerCase()
    .replace(/['’]/g, "") // "dexter's laboratory" → "dexters-laboratory", not "dexter-s-…"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export type MediaType = "show" | "movie" | "episode";

export function mediaPath(type: MediaType, id: number, title?: string | null): string {
  const slug = title ? slugify(title) : "";
  return `/${type}/${id}${slug && `-${slug}`}`;
}

// A public list's shareable URL: /u/joelnet/lists/2-favorites. Like media
// paths, only the numeric prefix identifies the list; the slug is advisory.
export function publicListPath(username: string, id: number, name?: string | null): string {
  const slug = name ? slugify(name) : "";
  return `/u/${username}/lists/${id}${slug && `-${slug}`}`;
}

// The :id route param may carry a slug suffix ("1405-dexter"); the leading
// digits are the id. Keep it a string — it goes straight into API paths.
export function idFromParam(param: string | undefined): string {
  return /^\d+/.exec(param ?? "")?.[0] ?? "";
}
