import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app";
import { markFirstShowNudgeSeen } from "../first-show";
import { useApi } from "../hooks";
import { useOffline } from "../offline";
import { PosterCard, Empty, ErrorNote, SmpteBars } from "../components/ui";
import { PosterGridSkeleton, TrendingSkeleton } from "../components/skeleton";
import { IconSearch } from "../components/icons";
import { mediaPath } from "../paths";

interface Result {
  type: "show" | "movie";
  id: number;
  title: string;
  year: string | null;
  poster: string | null;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { online } = useOffline();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const search = useApi<{ results: Result[] }>(q ? `/search?q=${encodeURIComponent(q)}` : null);
  const trending = useApi<{ shows: Result[]; movies: Result[] }>(!q ? "/trending" : null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The first-show popup. Both roads here set location.state.firstShow —
  // welcome.tsx right after signup, watchnext.tsx when a returning user's
  // library is still empty. The state is consumed on arrival with a same-URL
  // replace so refresh and Back can't resurrect the popup, and the per-visit
  // marker tells home not to bounce back here. Deep links with a query skip
  // the whole thing — that user is already mid-search.
  const arriving = (location.state ?? null) as { firstShow?: boolean; returning?: boolean } | null;
  const [nudge, setNudge] = useState<{ returning: boolean } | null>(null);
  const consumed = useRef(false);
  useEffect(() => {
    if (!arriving?.firstShow || consumed.current || q) return;
    consumed.current = true;
    markFirstShowNudgeSeen(user?.id);
    setNudge({ returning: !!arriving.returning });
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, []);

  // Search genuinely needs the network — a friendly note beats a broken error.
  const offlineNote = (
    <Empty title="You're offline" hint="Search needs a connection. Your library and lists still work offline." />
  );

  return (
    <div>
      <h1 className="page-title">Search</h1>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const next = (new FormData(e.currentTarget).get("q") as string).trim();
          setParams(next ? { q: next } : {});
        }}
      >
        <IconSearch size={18} />
        <input
          ref={inputRef}
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search shows & movies"
          aria-label="Search shows and movies"
          // When the popup is about to open, keep the field from grabbing
          // focus (and the mobile keyboard) for the tick before showModal
          // hands it to the dialog. The popup's CTA focuses it on close.
          autoFocus={!arriving?.firstShow}
        />
        <button className="btn" type="submit">Search</button>
      </form>

      {nudge && (
        <FirstShowNudge
          returning={nudge.returning}
          onDone={(findShow) => {
            setNudge(null);
            if (findShow) inputRef.current?.focus();
          }}
        />
      )}

      {q ? (
        search.loading ? (
          <PosterGridSkeleton />
        ) : search.error ? (
          online ? <ErrorNote message={search.error} /> : offlineNote
        ) : search.data?.results.length ? (
          <div className="poster-grid">
            {search.data.results.map((r) => (
              <PosterCard
                key={`${r.type}-${r.id}`}
                to={mediaPath(r.type, r.id, r.title)}
                posterPath={r.poster}
                title={r.title}
                sub={[r.type === "show" ? "TV" : "Movie", r.year].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
        ) : (
          <Empty title={`Nothing found for “${q}”`} hint="Check the spelling or try another title." />
        )
      ) : trending.loading ? (
        <TrendingSkeleton />
      ) : trending.data ? (
        <>
          <h2 className="section-title">Trending shows this week</h2>
          <div className="poster-grid">
            {trending.data.shows.map((r) => (
              <PosterCard key={r.id} to={mediaPath("show", r.id, r.title)} posterPath={r.poster} title={r.title} sub={r.year} />
            ))}
          </div>
          <h2 className="section-title">Trending movies</h2>
          <div className="poster-grid">
            {trending.data.movies.map((r) => (
              <PosterCard key={r.id} to={mediaPath("movie", r.id, r.title)} posterPath={r.poster} title={r.title} sub={r.year} />
            ))}
          </div>
        </>
      ) : trending.error ? (
        online ? <ErrorNote message={trending.error} /> : offlineNote
      ) : null}
    </div>
  );
}

// The first-show popup — the app's welcome mat. Native <dialog> on the same
// mechanics as ConfirmProvider (showModal, Esc, backdrop click) with a custom
// body: SMPTE strip, broadcast-voiced copy, one job. onDone(true) means the
// user hit "Find my show" — the caller hands focus to the search input.
function FirstShowNudge({ returning, onDone }: { returning: boolean; onDone: (findShow: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const resultRef = useRef(false);

  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const requestClose = (findShow: boolean) => {
    resultRef.current = findShow;
    ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      className="dialog first-show-nudge"
      aria-labelledby="first-show-title"
      onClose={() => onDone(resultRef.current)}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose(false); // backdrop
      }}
    >
      <div className="dialog-body">
        <SmpteBars />
        <h2 id="first-show-title">{returning ? "Next, Add a TV Show!" : "And… we're live!"}</h2>
        <p>Search for a TV show you're watching right now to get your lineup rolling.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" autoFocus onClick={() => requestClose(true)}>
            OK
          </button>
        </div>
      </div>
    </dialog>
  );
}
