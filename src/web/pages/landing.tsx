// Marketing landing page shown to logged-out visitors at "/".
// Static and client-side only; every claim maps to a shipped feature.
import { Link } from "react-router-dom";
import { Wordmark, SiteFooter, SmpteBars } from "../components/ui";
import { InstallAppButton } from "../components/install";
import { AuthCard } from "../components/auth-card";
import { PosterWall } from "../components/poster-wall";
import { DeviceShowcase } from "../components/device-showcase";
import { IconChevron } from "../components/icons";

// Developer link used in a couple of FAQ answers.
function JoelLink() {
  return (
    <a href="https://x.com/joelnet" target="_blank" rel="noopener noreferrer">
      Joel Thoms
    </a>
  );
}

// FAQ content. Questions render as native <details>/<summary>
// accordions: collapsed by default, click (or Enter/Space) toggles the answer.
const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: "Is there a native Android / iPhone app / Windows / MacOS?",
    a: (
      <>
        Yes! After signup, click the <strong>Install App</strong> in the top header of the site. Use
        Chrome or Safari for best results.
      </>
    ),
  },
  {
    q: "Who is developing this app?",
    a: (
      <>
        The app development is being handled by <JoelLink /> (software developer with over 30 years
        of professional software development experience)
      </>
    ),
  },
  {
    q: "Is this app vibe coded?",
    a: (
      <>
        Not exactly. While AI is used to create this app, the features, architectural, and security
        decisions are made by <JoelLink /> (a software developer with over 30 years of professional
        software development experience)
      </>
    ),
  },
  {
    q: "Is this free? Any fees?",
    a: "Free as in beer!",
  },
];

export function Landing() {
  return (
    <div className="landing">
      <header className="landing-header">
        <Wordmark />
        <div className="landing-header-actions">
          {/* Install App lives in the header here, same as the signed-in app
              header (Watch Next, Profile, …) rather than mid-page. */}
          <InstallAppButton buttonClass="header-install" />
          <Link to="/login" className="btn btn-ghost">
            Sign in
          </Link>
        </div>
      </header>

      <main className="landing-main">
        {/* --wall modifier: extra bottom padding keeps the poster wall inside
            the hero so the free badge below never overlaps it. */}
        <section className="landing-hero landing-hero--wall">
          <h1>Track your shows. Pick up where you left off.</h1>
          <p className="landing-sub">
            Show Us TV keeps track of every show and movie you watch: what&rsquo;s next, what&rsquo;s
            airing soon, and everything you&rsquo;ve finished.
          </p>
          <PosterWall />
        </section>

        <DeviceShowcase />

        {/* The exact same card as /login, opened in register mode. */}
        <section className="landing-signup" aria-label="Create your account">
          <AuthCard initialMode="register" />
        </section>

        {/* FAQ: the last block before the footer. Native
            <details> keeps the accordion keyboard-accessible with zero JS. */}
        <section className="landing-section landing-faq" aria-labelledby="faq-title">
          <div className="section-head">
            <SmpteBars />
            <p className="section-kicker">Viewer mail</p>
            <h2 className="section-lead" id="faq-title">
              Frequently asked questions
            </h2>
          </div>
          <div className="faq-list">
            {FAQS.map(({ q, a }) => (
              <details key={q} className="faq-item">
                <summary className="faq-q">
                  <span>{q}</span>
                  <span className="faq-chevron" aria-hidden="true">
                    <IconChevron size={14} />
                  </span>
                </summary>
                <p className="faq-a">{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
