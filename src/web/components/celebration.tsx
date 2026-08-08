// Caught-up celebration. Imperative, fire-and-forget:
//
//   const celebrate = useCelebrate();
//   celebrate("The Bear"); // → confetti burst + "You're all caught up on The Bear!"
//
// Because it's triggered from event handlers (not render), it fires exactly
// once per call — a re-render never replays it. The overlay is non-blocking:
// pointer-events are off so it never traps focus or swallows a click/navigation,
// and it auto-dismisses after a couple of seconds.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IconRewatch } from "./icons";

// A finished rewatch round is the same burst with different words: "you're
// all caught up" is the wrong sentence for someone who was already caught up
// and just watched the whole thing again. Pass the round number and the card
// says so instead.
interface CelebrateOptions {
  round?: number;
}

type CelebrateFn = (showTitle: string, opts?: CelebrateOptions) => void;

const CelebrationCtx = createContext<CelebrateFn>(() => {});

export const useCelebrate = () => useContext(CelebrationCtx);

// Brand palette — amber / cyan / red / green (see styles.css :root).
const COLORS = ["#ffae2e", "#56cfde", "#ff4d3d", "#58c983"];
const PIECES = 70;
const LIFETIME_MS = 3000; // whole effect: brief, then it clears itself

interface Burst {
  id: number;
  title: string;
  round?: number;
}

export function CelebrationProvider({ children }: { children: React.ReactNode }) {
  const [burst, setBurst] = useState<Burst | null>(null);
  const seq = useRef(0);

  const celebrate = useCallback<CelebrateFn>((title, opts) => {
    seq.current += 1;
    setBurst({ id: seq.current, title, round: opts?.round });
  }, []);

  // Tear the overlay down after the animation. `burst.id` in the deps means a
  // second completion while one is showing restarts the timer cleanly.
  useEffect(() => {
    if (!burst) return;
    const t = window.setTimeout(() => setBurst(null), LIFETIME_MS);
    return () => window.clearTimeout(t);
  }, [burst]);

  return (
    <CelebrationCtx.Provider value={celebrate}>
      {children}
      {burst && <Celebration key={burst.id} title={burst.title} round={burst.round} />}
    </CelebrationCtx.Provider>
  );
}

// Round 2 is the second time through, round 3 the third — the round number IS
// the times-through count, so the sub-line can say it in words.
const NTH = ["", "", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
const nthTimeThrough = (round: number) => (NTH[round] ? `${NTH[round]} time through` : `${round} times through`);

// One burst. Remounts per event (key={burst.id}), so the random particle field
// is generated once and the CSS animations run a single time.
function Celebration({ title, round }: { title: string; round?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: PIECES }, (_, i) => ({
        color: COLORS[i % COLORS.length],
        left: Math.random() * 100, // vw start
        drift: (Math.random() * 2 - 1) * 16, // vw horizontal travel
        spin: 360 + Math.random() * 540, // deg
        delay: Math.random() * 0.35, // s
        duration: 1.6 + Math.random() * 0.9, // s
        size: 7 + Math.random() * 6, // px
        round: i % 3 === 0,
      })),
    []
  );

  return (
    <div className="celebrate">
      <div className="celebrate-field" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className="celebrate-piece"
            style={{
              left: `${p.left}vw`,
              width: `${p.size}px`,
              height: `${p.size * 1.4}px`,
              background: p.color,
              borderRadius: p.round ? "50%" : "2px",
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              // Consumed by the confetti-fall keyframes.
              ["--drift" as string]: `${p.drift}vw`,
              ["--spin" as string]: `${p.spin}deg`,
            } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="celebrate-toast" role="status" aria-live="polite">
        {/* The round's mark is DRAWN (IconRewatch), not the literal "↻": no
            face in the app's stacks ships U+21BB, so the completion card —
            the single biggest ↻ in the product — was rendering a fallback
            hook that curls the opposite way from the icon on every badge
            behind it. */}
        <span className={`celebrate-emoji${round ? " celebrate-round" : ""}`} aria-hidden="true">
          {round ? <IconRewatch size={26} /> : "🎉"}
        </span>
        {round ? (
          <>
            <strong className="celebrate-headline">
              Round <em>{round}</em> in the books.
            </strong>
            <span className="celebrate-sub">
              {nthTimeThrough(round)}
              {title ? ` ${title}` : ""}. Every play is on the record.
            </span>
          </>
        ) : (
          <>
            <strong className="celebrate-headline">
              You&rsquo;re all caught up{title ? " on " : ""}
              {title && <em>{title}</em>}!
            </strong>
            <span className="celebrate-sub">Nice, you&rsquo;ve watched every episode that&rsquo;s aired.</span>
          </>
        )}
      </div>
    </div>
  );
}
