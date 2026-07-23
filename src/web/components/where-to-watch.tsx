import { justWatchSearchUrl } from "../../shared/justwatch";
import { providerLogo } from "../img";

export interface WatchInfo {
  providers: { name: string; logo: string | null }[];
}

// "Streaming" strip for the show and movie pages.
// Providers arrive from the worker already deduped to one row per service.
// A small "Streaming" heading sits on its own line above the (doubled-size)
// provider logos, with a smaller faded JustWatch credit below.
//
// The shelf links out to JustWatch — the source of TMDB's watch-provider data.
// TMDB only exposes its own watch page URL, which itself just
// redirects to JustWatch, so we skip that hop and build a JustWatch title
// search from the title here (deliberately ignoring any TMDB `link` a stale
// cached payload may still carry). `watch` is optional because an older
// cached payload has no such field.
export function WhereToWatch({ watch, title }: { watch?: WatchInfo; title: string }) {
  if (!watch?.providers?.length) return null;
  const logos = watch.providers.map((p) =>
    p.logo ? (
      <img key={p.name} src={providerLogo(p.logo)!} alt={p.name} title={p.name} loading="lazy" />
    ) : (
      <span key={p.name} className="provider-name">
        {p.name}
      </span>
    )
  );
  return (
    <div className="providers">
      <span className="providers-label">Streaming</span>
      <a
        className="providers-shelf"
        href={justWatchSearchUrl(title)}
        target="_blank"
        rel="noopener noreferrer"
        title="Find where to watch on JustWatch"
      >
        {logos}
        <span className="providers-out" aria-hidden="true">
          ↗
        </span>
      </a>
      <span className="justwatch">data by JustWatch</span>
    </div>
  );
}
