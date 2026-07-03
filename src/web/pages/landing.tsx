// Marketing landing page shown to logged-out visitors at "/".
// Static and client-side only; every claim maps to a shipped feature.
import { Link } from "react-router-dom";
import { SmpteBars, Wordmark } from "../components/ui";
import { InstallAppButton } from "../components/install";
import {
  IconPlay,
  IconCheck,
  IconCalendar,
  IconLibrary,
  IconList,
  IconStar,
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
    body: "A username and a password. That's the whole form.",
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

export function Landing() {
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
          <p className="landing-eyebrow">
            <span className="on-air-dot" aria-hidden="true" /> A home for TV Time refugees
          </p>
          <h1>
            Never lose your place in a show <em className="landing-bug">again</em>
          </h1>
          <p className="landing-sub">
            Show Us TV keeps track of every show and movie you watch — what&rsquo;s next, what&rsquo;s
            airing soon, and everything you&rsquo;ve finished.
          </p>
          <div className="landing-cta-row">
            <Link to="/login?mode=register" className="btn btn-lg">
              Create your account
            </Link>
            <Link to="/login" className="btn btn-ghost btn-lg">
              Sign in
            </Link>
          </div>
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
            Get started
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
