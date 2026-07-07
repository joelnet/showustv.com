// Public "Install App" walkthrough for iOS. Safari has no programmatic
// install, so the Header/InstallAppButton send iOS users here instead of a
// terse tooltip: a full page with step-by-step Add-to-Home-Screen
// instructions. The step figures are lightweight illustrations of the iOS
// Safari UI, not real screenshots — swap in captured PNGs when available.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { Wordmark, SiteFooter } from "../components/ui";
import { IconDownload, IconCheck } from "../components/icons";

// --- illustrations of each iOS Safari screen ---------------------------------

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="hero-shot help-shot">
      <div className="hero-shot-bar" aria-hidden="true">
        <span className="hero-shot-dots">
          <i style={{ background: "var(--red)" }} />
          <i style={{ background: "var(--amber)" }} />
          <i style={{ background: "var(--green)" }} />
        </span>
        <span className="hero-shot-url">{label}</span>
      </div>
      <div className="hero-shot-frame help-shot-frame">{children}</div>
    </figure>
  );
}

// The iOS "Share" glyph: an open-top box with an up arrow.
function ShareGlyph({ x, y, on }: { x: number; y: number; on?: boolean }) {
  const c = on ? "var(--amber, #f5a623)" : "var(--muted, #8e97a8)";
  return (
    <g transform={`translate(${x} ${y})`} stroke={c} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 -9 v-13" />
      <path d="M-5 -17 l5 -5 l5 5" />
      <path d="M-8 -5 h-5 a3 3 0 0 0 -3 3 v14 a3 3 0 0 0 3 3 h24 a3 3 0 0 0 3 -3 v-14 a3 3 0 0 0 -3 -3 h-5" />
    </g>
  );
}

function ShotShare() {
  return (
    <Frame label="Safari">
      <svg viewBox="0 0 320 200" role="img" aria-label="Illustration of Safari on iPhone: the Share button in the bottom toolbar is highlighted.">
        <rect width="320" height="200" fill="var(--surface, #14181f)" />
        {/* faux page */}
        <rect x="0" y="0" width="320" height="150" fill="var(--bg, #0f1218)" />
        <rect x="118" y="26" width="84" height="12" rx="6" fill="var(--amber, #f5a623)" opacity="0.85" />
        <rect x="40" y="58" width="240" height="8" rx="4" fill="var(--muted, #8e97a8)" opacity="0.35" />
        <rect x="40" y="76" width="200" height="8" rx="4" fill="var(--muted, #8e97a8)" opacity="0.25" />
        <rect x="40" y="100" width="60" height="76" rx="6" fill="var(--muted, #8e97a8)" opacity="0.18" />
        <rect x="110" y="100" width="60" height="76" rx="6" fill="var(--muted, #8e97a8)" opacity="0.18" />
        <rect x="180" y="100" width="60" height="76" rx="6" fill="var(--muted, #8e97a8)" opacity="0.18" />
        {/* toolbar */}
        <rect x="0" y="150" width="320" height="50" fill="var(--surface, #14181f)" />
        <line x1="0" y1="150" x2="320" y2="150" stroke="var(--line, #2a3344)" />
        <g stroke="var(--muted, #8e97a8)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M40 168 l-8 7 l8 7" />
          <path d="M78 168 l8 7 l-8 7" />
        </g>
        <rect x="112" y="164" width="96" height="22" rx="11" fill="var(--bg, #0f1218)" stroke="var(--line, #2a3344)" />
        <text x="160" y="179" fill="var(--muted, #8e97a8)" fontSize="10" fontFamily="sans-serif" textAnchor="middle">showustv.com</text>
        {/* highlighted share button */}
        <circle cx="248" cy="175" r="19" fill="var(--amber, #f5a623)" opacity="0.16" stroke="var(--amber, #f5a623)" />
        <ShareGlyph x={248} y={182} on />
        <g stroke="var(--muted, #8e97a8)" strokeWidth="2" fill="none">
          <rect x="278" y="167" width="7" height="7" rx="1" />
          <rect x="284" y="174" width="7" height="7" rx="1" />
        </g>
      </svg>
    </Frame>
  );
}

function ShotAddToHome() {
  const rows = [
    { label: "Copy", y: 92 },
    { label: "Add to Reading List", y: 116 },
    { label: "Add Bookmark", y: 140 },
    { label: "Add to Home Screen", y: 164, on: true },
  ];
  return (
    <Frame label="Share sheet">
      <svg viewBox="0 0 320 200" role="img" aria-label="Illustration of the iOS share sheet: the &quot;Add to Home Screen&quot; row is highlighted.">
        <rect width="320" height="200" fill="var(--bg, #0f1218)" />
        {/* sheet */}
        <rect x="16" y="16" width="288" height="184" rx="14" fill="var(--surface, #14181f)" stroke="var(--line, #2a3344)" />
        <rect x="146" y="26" width="28" height="4" rx="2" fill="var(--muted, #8e97a8)" opacity="0.5" />
        {/* share targets row */}
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={34 + i * 66} y={44} width="46" height="30" rx="8" fill="var(--bg, #0f1218)" stroke="var(--line, #2a3344)" />
        ))}
        {rows.map((r) => (
          <g key={r.label}>
            {r.on && <rect x="24" y={r.y - 15} width="272" height="24" rx="6" fill="var(--amber, #f5a623)" opacity="0.16" />}
            <text x="36" y={r.y} fill={r.on ? "var(--amber, #f5a623)" : "var(--text, #e7ecf3)"} fontSize="12" fontWeight={r.on ? 700 : 400} fontFamily="sans-serif">
              {r.label}
            </text>
            {/* trailing icon */}
            {r.on ? (
              <g transform="translate(276 0)" stroke="var(--amber, #f5a623)" strokeWidth="1.6" fill="none">
                <rect x="0" y={r.y - 13} width="16" height="16" rx="4" />
                <path d={`M8 ${r.y - 10} v10 M3 ${r.y - 5} h10`} strokeLinecap="round" />
              </g>
            ) : (
              <rect x="276" y={r.y - 13} width="16" height="16" rx="4" fill="none" stroke="var(--muted, #8e97a8)" strokeOpacity="0.5" strokeWidth="1.6" />
            )}
          </g>
        ))}
      </svg>
    </Frame>
  );
}

function ShotConfirm() {
  return (
    <Frame label="Add to Home Screen">
      <svg viewBox="0 0 320 200" role="img" aria-label="Illustration of the Add to Home Screen dialog with the app name Show Us TV and the Add button highlighted.">
        <rect width="320" height="200" fill="var(--bg, #0f1218)" />
        <rect x="16" y="20" width="288" height="160" rx="14" fill="var(--surface, #14181f)" stroke="var(--line, #2a3344)" />
        {/* top bar */}
        <text x="36" y="46" fill="var(--muted, #8e97a8)" fontSize="12" fontFamily="sans-serif">Cancel</text>
        <text x="160" y="46" fill="var(--text, #e7ecf3)" fontSize="12" fontWeight="700" fontFamily="sans-serif" textAnchor="middle">Add to Home Screen</text>
        <rect x="240" y="30" width="48" height="24" rx="8" fill="var(--amber, #f5a623)" opacity="0.16" stroke="var(--amber, #f5a623)" />
        <text x="264" y="46" fill="var(--amber, #f5a623)" fontSize="12" fontWeight="700" fontFamily="sans-serif" textAnchor="middle">Add</text>
        <line x1="16" y1="64" x2="304" y2="64" stroke="var(--line, #2a3344)" />
        {/* app icon + name */}
        <rect x="40" y="90" width="52" height="52" rx="12" fill="var(--amber, #f5a623)" />
        <text x="66" y="123" fill="#1a1205" fontSize="18" fontWeight="800" fontFamily="sans-serif" textAnchor="middle">TV</text>
        <rect x="108" y="92" width="168" height="22" rx="6" fill="var(--bg, #0f1218)" stroke="var(--line, #2a3344)" />
        <text x="118" y="107" fill="var(--text, #e7ecf3)" fontSize="12" fontWeight="600" fontFamily="sans-serif">Show Us TV</text>
        <text x="108" y="134" fill="var(--muted, #8e97a8)" fontSize="10" fontFamily="sans-serif">showustv.com</text>
      </svg>
    </Frame>
  );
}

const STEPS = [
  {
    title: "Tap the Share button",
    body: "Open showustv.com in Safari, then tap the Share button in the toolbar — the square with an arrow pointing up. On an iPhone it sits at the bottom of the screen; on an iPad, along the top.",
    shot: <ShotShare />,
  },
  {
    title: "Choose “Add to Home Screen”",
    body: "In the share sheet, scroll down the list of actions and tap “Add to Home Screen”. If you don’t see it, keep scrolling — it’s below the row of app icons.",
    shot: <ShotAddToHome />,
  },
  {
    title: "Tap “Add”",
    body: "Confirm the name (“Show Us TV” is fine) and tap Add in the top-right corner. The app icon appears on your Home Screen right away.",
    shot: <ShotConfirm />,
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
                {s.shot}
              </li>
            ))}
          </ol>
          <p className="settings-hint help-note">
            The screens above are illustrations of the iOS Safari flow. The real menus may look a
            little different depending on your iOS version.
          </p>
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
