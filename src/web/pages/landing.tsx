// Marketing landing page shown to logged-out visitors at "/".
// Static and client-side only; every claim maps to a shipped feature.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { SmpteBars, Wordmark, Slate } from "../components/ui";
import { InstallAppButton } from "../components/install";
import {
  IconPlay,
  IconCheck,
  IconCalendar,
  IconLibrary,
  IconList,
  IconStar,
  IconWarning,
} from "../components/icons";

const FEATURES = [
  {
    icon: IconPlay,
    title: "Watch Next queue",
    body: "Open the app and the next unwatched episode of every show you follow is waiting, with a count of what's left.",
  },
  {
    icon: IconCheck,
    title: "One-tap tracking",
    body: "Check off episodes as you watch. Jumping in mid-series? Marking an episode can catch up everything before it too.",
  },
  {
    icon: IconCalendar,
    title: "Never miss an air date",
    body: "See when the next episode of every show you follow airs, so premieres and finales never slip past.",
  },
  {
    icon: IconLibrary,
    title: "Library & watchlist",
    body: "Every show and movie you follow in one place, with progress bars — plus a watchlist for things you'll get to later.",
  },
  {
    icon: IconList,
    title: "Lists you can share",
    body: "Build custom lists and flip them public. Anyone with the link can view — no account needed on their end.",
  },
  {
    icon: IconStar,
    title: "Ratings & favorites",
    body: "Score what you watch 1–10 and heart your favorite shows so the best stuff stays on top.",
  },
];

const STEPS = [
  {
    title: "Create an account",
    body: "An email and a password. That's the whole form — we'll hand you a username you can change later.",
  },
  {
    title: "Find your shows",
    body: "Search the TMDB catalog for anything on the air — or anything that ever was — and hit Follow.",
  },
  {
    title: "Watch and check off",
    body: "Mark episodes as you go. Watch Next keeps your place in every show, every season.",
  },
];

// ---------- Feature showcase (issue #24 → #32) ----------
// Framed, on-brand previews built from the app's own components/CSS rather
// than static images, so they stay pixel-crisp and never drift from the
// product. Content is representative sample data, not a live capture.

function Shot({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <figure className="hero-shot showcase-shot">
      <div className="hero-shot-bar" aria-hidden="true">
        <span className="hero-shot-dots">
          <i style={{ background: "var(--red)" }} />
          <i style={{ background: "var(--amber)" }} />
          <i style={{ background: "var(--green)" }} />
        </span>
        <span className="hero-shot-url">{url}</span>
      </div>
      <div className="showcase-shot-body">{children}</div>
    </figure>
  );
}

function MockTile({ title, season, number, ep, date, left }: { title: string; season: number; number: number; ep: string; date: string; left: number }) {
  return (
    <article className="wn-tile">
      <div className="wn-tile-poster">
        <span className="mock-poster" aria-hidden="true" />
        <span className="pill wn-tile-count">{left} left</span>
      </div>
      <div className="wn-tile-body">
        <span className="wn-tile-show">{title}</span>
        <div className="wn-tile-ep">
          <Slate season={season} number={number} />
          <span>{ep}</span>
        </div>
        <span className="wn-tile-date mono">{date}</span>
      </div>
      <span className="btn btn-mark wn-tile-btn">
        <IconCheck size={14} /> <span>Watched</span>
      </span>
    </article>
  );
}

function MockList({ name, count }: { name: string; count: number }) {
  return (
    <div className="list-card">
      <div className="list-collage">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="mock-poster" aria-hidden="true" />
        ))}
      </div>
      <span className="list-name">{name}</span>
      <span className="mono list-count">{count} titles</span>
    </div>
  );
}

const SHOWCASE = [
  {
    title: "Your Watch Next queue",
    body: "Open the app and every show you follow is already lined up to its exact next episode, with a running count of what's left. No more “wait, where was I?”",
    url: "showustv.com",
    shot: (
      <div className="wn-grid">
        <MockTile title="The Bear" season={3} number={1} ep="Tomorrow" date="Jun 27" left={4} />
        <MockTile title="Severance" season={2} number={3} ep="Woe's Hollow" date="Jun 21" left={2} />
      </div>
    ),
  },
  {
    title: "Upcoming, on your radar",
    body: "See what's airing next across everything you follow, soonest first — so premieres and finales never slip past you.",
    url: "showustv.com",
    shot: (
      <ul className="agenda">
        <li>
          <span className="mono agenda-date">Jul 7</span>
          <span className="agenda-show">Foundation</span>
          <Slate season={3} number={4} />
          <span className="agenda-ep">Season's End</span>
        </li>
        <li>
          <span className="mono agenda-date">Jul 10</span>
          <span className="agenda-show">The Sandman</span>
          <Slate season={2} number={6} />
          <span className="agenda-ep">Lost Hearts</span>
        </li>
        <li>
          <span className="mono agenda-date">Jul 14</span>
          <span className="agenda-show">Wednesday</span>
          <Slate season={2} number={1} />
          <span className="agenda-ep">Return to Nevermore</span>
        </li>
      </ul>
    ),
  },
  {
    title: "Lists worth sharing",
    body: "Group shows and movies into lists — “Comfort rewatches”, “Watch with Sam” — then flip any of them public and share a link. No account needed to view.",
    url: "showustv.com/u/you/lists",
    shot: (
      <div className="lists-grid">
        <MockList name="Comfort rewatches" count={12} />
        <MockList name="Watch with Sam" count={7} />
      </div>
    ),
  },
];

export function Landing() {
  const { siteOpen } = useAuth();
  // While closed (pending licensing), sign-up is a wait list, not open access.
  const joinLabel = siteOpen ? "Create your account" : "Join the wait list";
  return (
    <div className="landing">
      <header className="landing-header">
        <Wordmark />
        <Link to="/login" className="btn btn-ghost">
          Sign in
        </Link>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <Link to="/import-help" className="landing-eyebrow landing-eyebrow--warn landing-eyebrow--link">
            <IconWarning size={13} /> TV Time is shutting down July 15 — import your data here
          </Link>
          <h1>
            Never lose your place in a show <em className="landing-bug">again</em>
          </h1>
          <p className="landing-sub">
            Show Us TV keeps track of every show and movie you watch — what&rsquo;s next, what&rsquo;s
            airing soon, and everything you&rsquo;ve finished.
          </p>
          <div className="landing-cta-row">
            <Link to="/login?mode=register" className="btn btn-lg">
              {joinLabel}
            </Link>
            <Link to="/login" className="btn btn-ghost btn-lg">
              Sign in
            </Link>
          </div>
          {!siteOpen && (
            <p className="landing-waitlist-note">
              Free — we&rsquo;ll email you the moment your account can sign in.
            </p>
          )}
          <InstallAppButton buttonClass="btn btn-ghost" />
          <figure className="hero-shot">
            <div className="hero-shot-bar" aria-hidden="true">
              <span className="hero-shot-dots">
                <i style={{ background: "var(--red)" }} />
                <i style={{ background: "var(--amber)" }} />
                <i style={{ background: "var(--green)" }} />
              </span>
              <span className="hero-shot-url">showustv.com/library</span>
            </div>
            <div className="hero-shot-frame">
              <img
                src="/screenshot-library.webp"
                width={1086}
                height={1038}
                decoding="async"
                alt="The Show Us TV library — a grid of followed shows with cover art and watch-progress bars."
              />
            </div>
          </figure>
          <SmpteBars />
        </section>

        <section className="landing-section" aria-labelledby="landing-features-title">
          <h2 className="section-title" id="landing-features-title">
            What it does
          </h2>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <article className="feature-card" key={f.title}>
                <span className="feature-icon" aria-hidden="true">
                  <f.icon size={18} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-showcase-title">
          <h2 className="section-title" id="landing-showcase-title">
            See it in action
          </h2>
          <div className="showcase">
            {SHOWCASE.map((s) => (
              <article className="showcase-row" key={s.title}>
                <div className="showcase-copy">
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
                <Shot url={s.url}>{s.shot}</Shot>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-steps-title">
          <h2 className="section-title" id="landing-steps-title">
            How it works
          </h2>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <code className="slate">{String(i + 1).padStart(2, "0")}</code>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-final">
          <h2>Ready to keep track?</h2>
          <p>Pick up right where you left off — from the very first episode.</p>
          <Link to="/login?mode=register" className="btn btn-lg">
            {siteOpen ? "Get started" : "Join the wait list"}
          </Link>
        </section>
      </main>

      <footer className="footer">
        <span>
          This product uses the <a href="https://www.themoviedb.org">TMDB</a> API but is not endorsed
          or certified by TMDB.
        </span>
      </footer>
    </div>
  );
}
