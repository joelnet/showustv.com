// Marketing landing page shown to logged-out visitors at "/".
// Static and client-side only; every claim maps to a shipped feature.
import { Link } from "react-router-dom";
import { Wordmark, SiteFooter } from "../components/ui";
import { InstallAppButton } from "../components/install";
import { AuthCard } from "../components/auth-card";
import { PosterWall } from "../components/poster-wall";
import { IconCheck, IconWarning } from "../components/icons";

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
          <Link to="/import-help" className="landing-eyebrow landing-eyebrow--warn landing-eyebrow--link">
            <IconWarning size={13} /> TV Time is shutting down July 15: import your data here
          </Link>
          <h1>
            Track your shows. Pickup where you <em className="landing-bug">left off</em>.
          </h1>
          <p className="landing-sub">
            Show Us TV keeps track of every show and movie you watch: what&rsquo;s next, what&rsquo;s
            airing soon, and everything you&rsquo;ve finished.
          </p>
          <p className="landing-freebadge">
            <IconCheck size={13} /> 100% free! No credit card, no ads!
          </p>
          <div className="landing-cta-row">
            <InstallAppButton buttonClass="btn btn-amber-ghost btn-lg" />
          </div>
          <PosterWall />
        </section>

        {/* The exact same card as /login, opened in register mode. */}
        <section className="landing-signup" aria-label="Create your account">
          <AuthCard initialMode="register" />
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
