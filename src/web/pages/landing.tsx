// Marketing landing page shown to logged-out visitors at "/".
// Static and client-side only; every claim maps to a shipped feature.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { poster } from "../img";
import { SmpteBars, Wordmark, Slate, SiteFooter } from "../components/ui";
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

// Tight one-clause rundown. The showcase below carries the proof, so these
// stay scannable and don't restate it.
const FEATURES = [
  {
    icon: IconPlay,
    title: "Watch Next queue",
    body: "The next episode of every show, queued and counted.",
  },
  {
    icon: IconCheck,
    title: "One-tap tracking",
    body: "Check off an episode, or catch up a whole run at once.",
  },
  {
    icon: IconCalendar,
    title: "Never miss an air date",
    body: "See what airs next across everything you follow.",
  },
  {
    icon: IconLibrary,
    title: "Library & watchlist",
    body: "Everything you follow, with progress bars and a watchlist.",
  },
  {
    icon: IconList,
    title: "Lists you can share",
    body: "Build lists and flip them public with a link.",
  },
  {
    icon: IconStar,
    title: "Ratings & favorites",
    body: "Rate things 1 to 10 and heart the best.",
  },
];

const STEPS = [
  {
    title: "Create an account",
    body: "An email and a password. That's the whole form; we'll hand you a username you can change later.",
  },
  {
    title: "Find your shows",
    body: "Search the TMDB catalog for anything on the air, or anything that ever was, and hit Follow.",
  },
  {
    title: "Watch and check off",
    body: "Mark episodes as you go. Watch Next keeps your place in every show, every season.",
  },
];

// ---------- Feature showcase (issue #24 → #32) ----------
// Framed previews built from the app's own components + real TMDB poster art,
// so they look exactly like the product and never drift from it. Episode/date
// values are representative sample data, not a live capture.

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

function MockTile({ posterPath, title, season, number, ep, date, left }: { posterPath: string; title: string; season: number; number: number; ep: string; date: string; left: number }) {
  return (
    <article className="wn-tile">
      <div className="wn-tile-poster">
        <img src={poster(posterPath, "w342")!} alt="" loading="lazy" />
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

function MockList({ name, count, posters }: { name: string; count: number; posters: string[] }) {
  return (
    <div className="list-card">
      <div className="list-collage">
        {posters.map((p, i) => (
          <img key={i} src={poster(p, "w154")!} alt="" loading="lazy" />
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
        <MockTile posterPath="/eKfVzzEazSIjJMrw9ADa2x8ksLz.jpg" title="The Bear" season={3} number={1} ep="Tomorrow" date="Jun 27" left={4} />
        <MockTile posterPath="/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg" title="Severance" season={2} number={3} ep="Woe's Hollow" date="Jun 21" left={2} />
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
        <MockList
          name="Comfort rewatches"
          count={12}
          posters={[
            "/7DJKHzAi83BmQrWLrYYOqcoKfhR.jpg", // The Office
            "/5fhZdwP1DVJ0FyVH6vrFdHwpXIn.jpg", // Ted Lasso
            "/27vEYsRKa3eAniwmoccOoluEXQ1.jpg", // Fleabag
            "/zOVCqKUzjFKqa1eDMcOzvXwthY4.jpg", // The Grand Budapest Hotel
          ]}
        />
        <MockList
          name="Watch with Sam"
          count={7}
          posters={[
            "/dmo6TYuuJgaYinXBPjrgG9mB5od.jpg", // The Last of Us
            "/7O4iVfOMQmdCSxhOg1WnzG1AgYT.jpg", // Shōgun
            "/abf8tHznhSvl9BAElD2cQeRr7do.jpg", // Arcane
            "/gDzOcq0pfeCeqMBwKIJlSmQpjkZ.jpg", // Dune
          ]}
        />
      </div>
    ),
  },
];

// Section opener: a short broadcast bar, a mono kicker, and a real display
// headline, so each section announces itself between the big hero and the body.
function SectionHead({ id, kicker, children }: { id: string; kicker: string; children: React.ReactNode }) {
  return (
    <header className="section-head">
      <SmpteBars />
      <span className="section-kicker">{kicker}</span>
      <h2 className="section-lead" id={id}>
        {children}
      </h2>
    </header>
  );
}

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
        </section>

        <section className="landing-section" aria-labelledby="landing-features-title">
          <SectionHead id="landing-features-title" kicker="What it does">
            Everything you follow, on one dial
          </SectionHead>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <article className="feature-card" key={f.title}>
                <h3>
                  <span className="feature-icon" aria-hidden="true">
                    <f.icon size={17} />
                  </span>
                  {f.title}
                </h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-showcase-title">
          <SectionHead id="landing-showcase-title" kicker="See it in action">
            This is the actual app
          </SectionHead>
          <div className="showcase">
            {SHOWCASE.map((s, i) => (
              <article className="showcase-row" key={s.title}>
                <div className="showcase-copy">
                  <span className="showcase-kicker">
                    {String(i + 1).padStart(2, "0")} <span>/ {String(SHOWCASE.length).padStart(2, "0")}</span>
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
                <Shot url={s.url}>{s.shot}</Shot>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-steps-title">
          <SectionHead id="landing-steps-title" kicker="How it works">
            On the air in three steps
          </SectionHead>
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
          <p>Pick up right where you left off, from the very first episode.</p>
          <Link to="/login?mode=register" className="btn btn-lg">
            {siteOpen ? "Get started" : "Join the wait list"}
          </Link>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
