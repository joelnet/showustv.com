// Public how-to page for moving a TV Time history over before TV Time shuts
// down (2026-07-15). Reachable logged-out (linked from the landing banner) and
// logged-in; the final CTA adapts to whether you're signed in.
//
// The step figures are lightweight wireframe illustrations of the TV Time
// export screens, not real screenshots — swap in captured PNGs when available.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { Wordmark, SiteFooter } from "../components/ui";
import { IconWarning, IconDownload, IconExternal, IconCheck } from "../components/icons";

// TV Time's GDPR self-service export (same link the importer points at).
const TVTIME_EXPORT_URL = "https://gdpr.tvtime.com/gdpr/self-service";
// TV Time announced shutdown date.
const SHUTDOWN_DATE = "July 15, 2026";

// --- wireframe illustrations of each export screen ---------------------------

function Frame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <figure className="hero-shot help-shot">
      <div className="hero-shot-bar" aria-hidden="true">
        <span className="hero-shot-dots">
          <i style={{ background: "var(--red)" }} />
          <i style={{ background: "var(--amber)" }} />
          <i style={{ background: "var(--green)" }} />
        </span>
        <span className="hero-shot-url">{url}</span>
      </div>
      <div className="hero-shot-frame help-shot-frame">{children}</div>
    </figure>
  );
}

function ShotRequest() {
  return (
    <Frame url="gdpr.tvtime.com/gdpr/self-service">
      <svg viewBox="0 0 320 190" role="img" aria-label="Illustration of the TV Time data-export page: an email field above a Request my data button.">
        <rect width="320" height="190" fill="var(--surface, #14181f)" />
        <text x="20" y="34" fill="var(--text, #e7ecf3)" fontSize="15" fontWeight="700" fontFamily="sans-serif">Request your data</text>
        <text x="20" y="54" fill="var(--muted, #8e97a8)" fontSize="9" fontFamily="sans-serif">Enter your TV Time account email.</text>
        <rect x="20" y="70" width="280" height="30" rx="6" fill="none" stroke="var(--muted, #8e97a8)" strokeOpacity="0.5" />
        <text x="32" y="89" fill="var(--muted, #8e97a8)" fontSize="10" fontFamily="sans-serif">you@example.com</text>
        <rect x="20" y="118" width="150" height="34" rx="7" fill="var(--amber, #f5a623)" />
        <text x="95" y="140" fill="#1a1205" fontSize="11" fontWeight="700" fontFamily="sans-serif" textAnchor="middle">Request my data</text>
      </svg>
    </Frame>
  );
}

function ShotEmail() {
  return (
    <Frame url="mail: Your TV Time data is ready">
      <svg viewBox="0 0 320 190" role="img" aria-label="Illustration of the email from TV Time containing a download link for your data archive.">
        <rect width="320" height="190" fill="var(--surface, #14181f)" />
        <circle cx="36" cy="40" r="14" fill="var(--amber, #f5a623)" fillOpacity="0.25" />
        <text x="36" y="45" fill="var(--amber, #f5a623)" fontSize="14" fontFamily="sans-serif" textAnchor="middle">✉</text>
        <text x="62" y="36" fill="var(--text, #e7ecf3)" fontSize="12" fontWeight="700" fontFamily="sans-serif">TV Time</text>
        <text x="62" y="52" fill="var(--muted, #8e97a8)" fontSize="9" fontFamily="sans-serif">Your data export is ready to download</text>
        <line x1="20" y1="72" x2="300" y2="72" stroke="var(--muted, #8e97a8)" strokeOpacity="0.2" />
        <text x="20" y="96" fill="var(--muted, #8e97a8)" fontSize="9" fontFamily="sans-serif">Your archive is ready. It expires in a few days.</text>
        <rect x="20" y="112" width="170" height="34" rx="7" fill="none" stroke="var(--amber, #f5a623)" />
        <text x="105" y="134" fill="var(--amber, #f5a623)" fontSize="11" fontWeight="700" fontFamily="sans-serif" textAnchor="middle">Download my data ↓</text>
      </svg>
    </Frame>
  );
}

function ShotUpload() {
  return (
    <Frame url="showustv.com/settings/import">
      <svg viewBox="0 0 320 190" role="img" aria-label="Illustration of the Show Us TV import screen with a Choose zip file button.">
        <rect width="320" height="190" fill="var(--surface, #14181f)" />
        <text x="20" y="34" fill="var(--text, #e7ecf3)" fontSize="15" fontWeight="700" fontFamily="sans-serif">Import from TV Time</text>
        <rect x="20" y="52" width="280" height="76" rx="10" fill="none" stroke="var(--muted, #8e97a8)" strokeOpacity="0.5" strokeDasharray="5 4" />
        <text x="160" y="82" fill="var(--muted, #8e97a8)" fontSize="20" fontFamily="sans-serif" textAnchor="middle">↑</text>
        <text x="160" y="104" fill="var(--muted, #8e97a8)" fontSize="9" fontFamily="sans-serif" textAnchor="middle">tvtime-export.zip</text>
        <rect x="20" y="142" width="150" height="32" rx="7" fill="var(--green, #3ddc84)" />
        <text x="95" y="163" fill="#052012" fontSize="11" fontWeight="700" fontFamily="sans-serif" textAnchor="middle">Choose zip file…</text>
      </svg>
    </Frame>
  );
}

const STEPS = [
  {
    title: "Open TV Time's data export page",
    body: (
      <>
        TV Time offers a GDPR self-service export. Open{" "}
        <a href={TVTIME_EXPORT_URL} target="_blank" rel="noreferrer">
          gdpr.tvtime.com <IconExternal size={11} />
        </a>{" "}
        and sign in with the same account you use in the TV Time app.
      </>
    ),
    shot: <ShotRequest />,
  },
  {
    title: "Request your data",
    body: (
      <>
        Enter your account email and choose <strong>Request my data</strong>. TV Time assembles a zip
        archive of your shows, watched episodes, follows and favorites. This can take anywhere from a
        few minutes to a day.
      </>
    ),
    shot: null,
  },
  {
    title: "Download the archive from your email",
    body: (
      <>
        When it's ready, TV Time emails you a download link. Open it and save the{" "}
        <strong>.zip</strong> file to your device. No need to unzip it. Keep it as-is.
      </>
    ),
    shot: <ShotEmail />,
  },
  {
    title: "Upload it to Show Us TV",
    body: (
      <>
        Head to the import screen and pick that zip file. Everything is unpacked{" "}
        <strong>right in your browser</strong>: only the shows, episodes, movies and favorites we can
        match are sent to the server, and you'll see a full preview before anything is imported.
      </>
    ),
    shot: <ShotUpload />,
  },
];

export function ImportHelpPage() {
  const { user } = useAuth();
  const importTo = user ? "/settings/import" : "/login?mode=register";

  return (
    <div className="landing import-help">
      <header className="landing-header">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
          <Wordmark />
        </Link>
        <Link to={user ? "/settings/import" : "/login"} className="btn btn-ghost">
          {user ? "Import screen" : "Sign in"}
        </Link>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <p className="landing-eyebrow landing-eyebrow--warn">
            <IconWarning size={13} /> TV Time is shutting down on {SHUTDOWN_DATE}
          </p>
          <h1>
            Bring your TV Time history <em className="landing-bug">with you</em>
          </h1>
          <p className="landing-sub">
            Don&rsquo;t lose years of tracked shows and episodes. Export your data from TV Time and
            import it into Show Us TV in a few steps: your watch history, follows and favorites come
            along, with their original watch dates.
          </p>
          <div className="landing-cta-row">
            <a href={TVTIME_EXPORT_URL} target="_blank" rel="noreferrer" className="btn btn-lg">
              <IconDownload size={15} /> Export from TV Time
            </a>
            <Link to={importTo} className="btn btn-ghost btn-lg">
              {user ? "Go to import" : "Create an account"}
            </Link>
          </div>
        </section>

        <section className="landing-section" aria-labelledby="help-steps-title">
          <h2 className="section-title" id="help-steps-title">
            How to move your data
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
                {s.shot}
              </li>
            ))}
          </ol>
          <p className="settings-hint help-note">
            The screens above are illustrations of the TV Time export flow. The real pages may look a
            little different.
          </p>
        </section>

        <section className="landing-final">
          <h2>
            <IconCheck size={20} /> Re-run it anytime
          </h2>
          <p>
            Importing never duplicates history, so if you watch a few more episodes on TV Time before
            it closes, just export again and re-import. Only the new items are added.
          </p>
          <Link to={importTo} className="btn btn-lg">
            {user ? "Import your data" : "Get started"}
          </Link>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
