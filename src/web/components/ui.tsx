import { Link } from "react-router-dom";
import { poster } from "../img";
import { epCode } from "../format";
import { EMOJI_REACTIONS } from "../../shared/constants";
import { IconCheck, IconX, IconDiscord, IconImdb, IconRottenTomatoes } from "./icons";

// External social links for the footer (issue #75).
const SOCIALS = [
  { label: "X", href: "https://x.com/joelnet", Icon: IconX },
  { label: "Discord", href: "https://discord.gg/AxPcm4xjJC", Icon: IconDiscord },
];

// Indeterminate spinner — kept only for the pre-boot auth check, where the
// upcoming layout is unknown. Content loading states use the skeleton
// loaders in components/skeleton.tsx instead (issue #138).
export function Spinner() {
  return (
    <div className="spinner-wrap" role="status" aria-label="Loading">
      <div className="spinner" />
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="error-note">{message}</p>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-static" aria-hidden="true" />
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

// The SMPTE color-bar strip — brand divider.
export function SmpteBars() {
  return <div className="smpte" aria-hidden="true" />;
}

// Shared site footer: the required TMDB attribution plus the legal links, so
// Privacy/Terms are reachable from every page (signed in or out). `children`
// lets a context prepend its own link — the signed-in Shell adds About, which
// lives behind auth and so isn't shown in the logged-out footers.
export function SiteFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="footer">
      <span>
        This product uses the <a href="https://www.themoviedb.org">TMDB</a> API but is not endorsed
        or certified by TMDB.
      </span>
      <nav className="footer-socials" aria-label="Social links">
        {SOCIALS.map(({ label, href, Icon }) => (
          <a key={label} href={href} target="_blank" rel="noreferrer" aria-label={`Show Us TV on ${label}`}>
            <Icon size={18} />
          </a>
        ))}
      </nav>
      <nav className="footer-links" aria-label="Footer">
        {children}
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </nav>
    </footer>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      SHOW US{" "}
      <span className="wordmark-bug" role="img" aria-label="TV">
        <svg className="wordmark-tv" viewBox="0 3 30 26" aria-hidden="true" focusable="false">
          {/* antennae */}
          <line x1="12.2" y1="10" x2="5.8" y2="4.2" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round" />
          <line x1="17.8" y1="10" x2="24.2" y2="4.2" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round" />
          {/* TV body */}
          <rect x="1.5" y="9" width="27" height="20" rx="4.5" ry="4.5" fill="var(--amber)" />
          {/* "TV" letters, stroke-drawn and slanted to sit with the italic
              wordmark. Drawn in the page background so they read as knocked
              out of the amber screen. */}
          <g
            transform="translate(3.37 0) skewX(-10)"
            stroke="var(--bg)"
            strokeWidth="2.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          >
            <path d="M6.8 14.4 H13.6 M10.2 14.4 V23.8" />
            <path d="M16.6 14.4 L19.6 23.8 L22.6 14.4" />
          </g>
        </svg>
      </span>
    </span>
  );
}

// Off-site links for detail pages (issues #12, #292). Each brand renders as
// its bundled logo (see icons.tsx) linking out, mirroring the streaming-logo
// treatment above. IMDb links straight to the title once the catalog row has
// synced its imdb_id; until then (and always for Rotten Tomatoes, which
// exposes no stable id mapping) the link is a title search on the target site.
export function ExternalLinks({ title, imdbId }: { title: string; imdbId: string | null }) {
  const q = encodeURIComponent(title);
  const links = [
    {
      name: "IMDb",
      href: imdbId ? `https://www.imdb.com/title/${imdbId}/` : `https://www.imdb.com/find/?q=${q}`,
      Logo: IconImdb,
    },
    {
      name: "Rotten Tomatoes",
      href: `https://www.rottentomatoes.com/search?search=${q}`,
      Logo: IconRottenTomatoes,
    },
  ];
  return (
    <div className="external-links">
      <span className="external-links-label">Elsewhere</span>
      <div className="external-logos">
        {links.map(({ name, href, Logo }) => (
          <a
            key={name}
            className="external-logo"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={name}
            aria-label={name}
          >
            <Logo size={36} />
          </a>
        ))}
      </div>
    </div>
  );
}

// Production-slate episode code: S02·E05.
export function Slate({ season, number }: { season: number; number: number }) {
  return <code className="slate">{epCode(season, number)}</code>;
}

export function Progress({ watched, total }: { watched: number; total: number }) {
  const pct = total > 0 ? Math.round((watched / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

// Poster tile. `sub` is a muted line under the title. `pill` (issue #223,
// Finished library cards) swaps the whole text meta block for a count pill
// overlaid on the art's corner — the same treatment as the Watch Next thumb
// pills — so the title moves to the link's aria-label and hover tooltip.
export function PosterCard({
  to,
  posterPath,
  title,
  sub,
  pill,
}: {
  to: string;
  posterPath: string | null;
  title: string;
  sub?: string | null;
  pill?: string;
}) {
  const src = poster(posterPath);
  return (
    <Link to={to} className="poster-card" aria-label={pill ? `${title}, ${pill}` : undefined} title={pill ? title : undefined}>
      {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{title}</div>}
      {pill ? (
        <span className="pill poster-card-pill">{pill}</span>
      ) : (
        <div className="poster-card-meta">
          <span className="poster-card-title">{title}</span>
          {sub && <span className="poster-card-sub">{sub}</span>}
        </div>
      )}
    </Link>
  );
}

// Round watched-toggle. Filled green check = watched.
export function CheckButton({
  checked,
  onToggle,
  label,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`check-btn${checked ? " is-checked" : ""}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={checked}
      aria-label={label}
      title={label}
    >
      <IconCheck size={16} />
    </button>
  );
}

export function ScorePicker({
  value,
  onPick,
}: {
  value: number | null;
  onPick: (score: number) => void;
}) {
  return (
    <div className="score-picker" role="radiogroup" aria-label="Rate 1 to 10">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={`score-dot${value != null && n <= value ? " is-on" : ""}`}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

export function EmojiPicker({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="emoji-picker" role="radiogroup" aria-label="Reaction">
      {EMOJI_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          className={`emoji-btn${value === e ? " is-on" : ""}`}
          onClick={() => onPick(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
