// Caught-up celebration (issue #53). Imperative, fire-and-forget:
//
//   const celebrate = useCelebrate();
//   celebrate("The Bear"); // → confetti burst + "You're all caught up on The Bear!"
//
// Because it's triggered from event handlers (not render), it fires exactly
// once per call — a re-render never replays it. The overlay is non-blocking:
// pointer-events are off so it never traps focus or swallows a click/navigation,
// and it auto-dismisses after a couple of seconds.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type CelebrateFn = (showTitle: string) => void;

const CelebrationCtx = createContext<CelebrateFn>(() => {});

export const useCelebrate = () => useContext(CelebrationCtx);

// Brand palette — amber / cyan / red / green (see styles.css :root).
const COLORS = ["#ffae2e", "#56cfde", "#ff4d3d", "#58c983"];
const PIECES = 70;
const LIFETIME_MS = 3000; // whole effect: brief, then it clears itself

interface Burst {
  id: number;
  title: string;
}

export function CelebrationProvider({ children }: { children: React.ReactNode }) {
  const [burst, setBurst] = useState<Burst | null>(null);
  const seq = useRef(0);

  const celebrate = useCallback<CelebrateFn>((title) => {
    seq.current += 1;
    setBurst({ id: seq.current, title });
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
      {burst && <Celebration key={burst.id} title={burst.title} />}
    </CelebrationCtx.Provider>
  );
}

// One burst. Remounts per event (key={burst.id}), so the random particle field
// is generated once and the CSS animations run a single time.
function Celebration({ title }: { title: string }) {
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
        <span className="celebrate-emoji" aria-hidden="true">
          🎉
        </span>
        <strong className="celebrate-headline">
          You&rsquo;re all caught up{title ? " on " : ""}
          {title && <em>{title}</em>}!
        </strong>
        <span className="celebrate-sub">Nice, you&rsquo;ve watched every episode that&rsquo;s aired.</span>
      </div>
    </div>
  );
}
