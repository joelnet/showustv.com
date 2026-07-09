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
        <div className="landing-header-actions">
          {/* Install App lives in the header here, same as the signed-in app
              header (Watch Next, Profile, …) rather than mid-page (issue #125). */}
          <InstallAppButton buttonClass="header-install" />
          <Link to="/login" className="btn btn-ghost">
            Sign in
          </Link>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <Link to="/import-help" className="landing-eyebrow landing-eyebrow--warn landing-eyebrow--link">
            <IconWarning size={13} /> TV Time is shutting down July 15: import your data here
          </Link>
          <h1>Track your shows. Pickup where you left off.</h1>
          <p className="landing-sub">
            Show Us TV keeps track of every show and movie you watch: what&rsquo;s next, what&rsquo;s
            airing soon, and everything you&rsquo;ve finished.
          </p>
          <PosterWall />
        </section>

        {/* Free badge sits below the hero rather than inside it (issue #124). */}
        <p className="landing-freebadge">
          <IconCheck size={13} /> 100% free! No credit card, no ads!
        </p>

        {/* The exact same card as /login, opened in register mode. */}
        <section className="landing-signup" aria-label="Create your account">
          <AuthCard initialMode="register" />
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
