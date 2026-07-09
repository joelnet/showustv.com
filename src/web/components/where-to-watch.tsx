import { providerLogo } from "../img";

export interface WatchInfo {
  link: string | null;
  providers: { name: string; logo: string | null }[];
}

// "Where to watch" strip for the show and movie pages (issue #144).
// Providers arrive from the worker already deduped to one row per service.
// TMDB's watch-provider terms want JustWatch credited wherever the data
// renders and users sent to the title's TMDB watch page (which holds the
// actual deep links), so the shelf links out when TMDB supplies one.
// `watch` is optional because a pre-#144 cached payload has no such field.
export function WhereToWatch({ watch }: { watch?: WatchInfo }) {
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
      <span className="providers-label">Where to watch</span>
      {watch.link ? (
        <a
          className="providers-shelf"
          href={watch.link}
          target="_blank"
          rel="noopener noreferrer"
          title="All watch options on TMDB"
        >
          {logos}
          <span className="providers-out" aria-hidden="true">
            ↗
          </span>
        </a>
      ) : (
        <span className="providers-shelf">{logos}</span>
      )}
      <span className="justwatch">Streaming data by JustWatch</span>
    </div>
  );
}
