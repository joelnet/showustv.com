import { Link } from "react-router-dom";
import { poster } from "../img";
import { epCode } from "../format";
import { EMOJI_REACTIONS } from "../../shared/constants";
import { IconCheck } from "./icons";

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

export function Wordmark() {
  return (
    <span className="wordmark">
      SHOW US <span className="wordmark-bug">TV</span>
    </span>
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

export function PosterCard({
  to,
  posterPath,
  title,
  sub,
}: {
  to: string;
  posterPath: string | null;
  title: string;
  sub?: string | null;
}) {
  const src = poster(posterPath);
  return (
    <Link to={to} className="poster-card">
      {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{title}</div>}
      <div className="poster-card-meta">
        <span className="poster-card-title">{title}</span>
        {sub && <span className="poster-card-sub">{sub}</span>}
      </div>
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
