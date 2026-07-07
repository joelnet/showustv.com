// Public "Install App" walkthrough for iOS. Safari has no programmatic
// install, so the Header/InstallAppButton send iOS users here instead of a
// terse tooltip: a full page with real iPhone screenshots of the
// Add-to-Home-Screen flow.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { Wordmark, SiteFooter } from "../components/ui";
import { IconDownload, IconCheck } from "../components/icons";

const STEPS = [
  {
    title: "Tap the Share button",
    body: "Open showustv.com in Safari, then tap the Share button in the toolbar — the square with an arrow pointing up. On an iPhone it sits at the bottom of the screen.",
    shot: "/install-share.png",
    alt: "The Safari toolbar on iPhone with the Share button circled.",
    wide: true,
  },
  {
    title: "Choose “Add to Home Screen”",
    body: "In the share sheet, scroll down the list of actions and tap “Add to Home Screen”. If you don’t see it, keep scrolling — it’s below the row of app icons.",
    shot: "/install-add.png",
    alt: "The iOS share sheet with the “Add to Home Screen” option circled.",
  },
  {
    title: "Tap “Add”",
    body: "Confirm the name (“Show Us TV” is fine) and tap Add in the top-right corner. The icon lands on your Home Screen right away — open it and it runs full screen, like a native app.",
    shot: null as string | null,
    alt: "",
  },
];

export function InstallPage() {
  const { user } = useAuth();

  return (
    <div className="landing import-help">
      <header className="landing-header">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
          <Wordmark />
        </Link>
        <Link to={user ? "/" : "/login"} className="btn btn-ghost">
          {user ? "Back to app" : "Sign in"}
        </Link>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <p className="landing-eyebrow">
            <IconDownload size={13} /> Install on iPhone &amp; iPad
          </p>
          <h1>
            Add Show Us TV to your <em className="landing-bug">Home Screen</em>
          </h1>
          <p className="landing-sub">
            Safari can install Show Us TV like a native app: it opens full screen, with no address bar,
            and lives on your Home Screen next to everything else. It takes three taps.
          </p>
          <figure className="install-hero-shot">
            <img
              src="/install-home.png"
              width={512}
              height={357}
              alt="An iPhone Home Screen with the Show Us TV app icon installed alongside other apps."
            />
          </figure>
        </section>

        <section className="landing-section" aria-labelledby="install-steps-title">
          <h2 className="section-title" id="install-steps-title">
            How to install
          </h2>
          <ol className="help-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="help-step">
                <div className="help-step-text">
                  <code className="slate">{String(i + 1).padStart(2, "0")}</code>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                  </div>
                </div>
                {s.shot && (
                  <figure className={`install-shot${s.wide ? " install-shot--wide" : ""}`}>
                    <img src={s.shot} alt={s.alt} loading="lazy" />
                  </figure>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-final">
          <h2>
            <IconCheck size={20} /> That&rsquo;s it
          </h2>
          <p>
            Open Show Us TV from your Home Screen and it runs full screen, like a native app. Prefer
            the browser? That keeps working too — nothing changes.
          </p>
          <div className="landing-cta-row">
            <Link to={user ? "/" : "/login?mode=register"} className="btn btn-lg">
              {user ? "Back to app" : "Create your account"}
            </Link>
          </div>
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}
