// Privacy Policy and Terms of Service. Public, standalone pages
// (reachable signed in or out) that share a lightweight landing-style chrome
// and the site footer. The copy describes what the app actually does today:
// email + password accounts, a signed session cookie, watch history, and the
// TMDB / JustWatch / Resend / Cloudflare services it relies on. There is no
// analytics or advertising, and no tracking cookies — keep it that way if you
// edit here.
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import { Wordmark, SiteFooter } from "../components/ui";

// Human-readable date the copy below was last reviewed.
const LAST_UPDATED = "July 4, 2026";
// Placeholder contact addresses. They follow the noreply@showustv.com pattern
// already used for outbound mail; point them at real inboxes before launch.
const PRIVACY_EMAIL = "privacy@showustv.com";
const SUPPORT_EMAIL = "support@showustv.com";

function LegalLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  return (
    <div className="landing legal-page">
      <header className="landing-header">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
          <Wordmark />
        </Link>
        <Link to={user ? "/" : "/login"} className="btn btn-ghost">
          {user ? "Back to app" : "Sign in"}
        </Link>
      </header>

      <main className="landing-main">
        <article className="legal">
          <h1 className="legal-title">{title}</h1>
          <p className="legal-updated mono">Last updated {LAST_UPDATED}</p>
          {children}
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        Show Us TV (&ldquo;Show Us TV&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a personal
        tracker for the TV shows and movies you watch. This policy explains what we collect, why, and
        the choices you have. We&rsquo;ve tried to keep it plain: we collect only what the tracker
        needs to work, we don&rsquo;t run advertising or third-party analytics, and we don&rsquo;t
        sell your data.
      </p>

      <h2>Information we collect</h2>
      <h3>Account information</h3>
      <p>When you create an account we store:</p>
      <ul>
        <li>
          <strong>Your email address</strong>: it&rsquo;s how you sign in and how we send account
          email such as verification links.
        </li>
        <li>
          <strong>Your password</strong>: never in plain text. We store only a salted hash
          (PBKDF2), which cannot be reversed back into your password.
        </li>
        <li>
          <strong>A username</strong>: we generate a random, friendly handle for you at sign-up.
          You can change it later.
        </li>
        <li>
          <strong>Your time zone</strong>: so air dates and &ldquo;watched&rdquo; dates line up with
          your local time.
        </li>
      </ul>

      <h3>Your tracking activity</h3>
      <p>As you use the app we store the data that makes it useful to you, including:</p>
      <ul>
        <li>The shows and movies you follow, and your watchlist.</li>
        <li>Which episodes you&rsquo;ve marked watched, and when.</li>
        <li>Ratings, favorites, lists you build, and comments or reactions you post.</li>
      </ul>
      <p>
        If you import a history from TV Time, the export file is unpacked{" "}
        <strong>in your browser</strong>. Only the shows, episodes, movies and favorites we can match
        are sent to our server; the rest never leaves your device.
      </p>

      <h3>Technical information</h3>
      <p>
        To keep you signed in we set a single essential cookie (see{" "}
        <a href="#cookies">Cookies</a> below). Our servers keep short-lived operational logs (the
        kind any web server produces) to run the service and investigate abuse or errors. We do{" "}
        <strong>not</strong> use Google Analytics, advertising trackers, or third-party profiling
        tools.
      </p>

      <h2 id="cookies">Cookies and local storage</h2>
      <p>
        We use exactly one cookie, named <code>sess</code>. It holds a signed session token (your
        account id and time zone) so you don&rsquo;t have to log in on every request. It is{" "}
        <code>HttpOnly</code>, sent over HTTPS, and expires after 30 days. It is strictly necessary
        for the site to function. It is not used for advertising or cross-site tracking, so no cookie
        banner is required.
      </p>
      <p>
        The app also stores data locally in your browser (via IndexedDB) so it can work offline and
        queue changes until you&rsquo;re back online. That data lives on your device and syncs to your
        account when a connection returns; clearing your browser storage removes it.
      </p>

      <h2>How we use your information</h2>
      <ul>
        <li>To provide the tracker: keep your place, show what&rsquo;s next, and sync across devices.</li>
        <li>To sign you in and keep your account secure.</li>
        <li>To send account email you ask for, such as email-verification links.</li>
        <li>To display content you choose to make public, like shared lists and your public profile.</li>
        <li>To operate, debug, and protect the service against abuse.</li>
      </ul>

      <h2>Third-party services</h2>
      <p>To run Show Us TV we rely on a small number of service providers:</p>
      <ul>
        <li>
          <strong>The Movie Database (TMDB)</strong>: supplies show and movie metadata and imagery.
          When the app loads posters or details it requests them from TMDB. This product uses the TMDB
          API but is not endorsed or certified by TMDB.
        </li>
        <li>
          <strong>JustWatch</strong>: provides the &ldquo;where to watch&rdquo; streaming
          availability shown on some pages.
        </li>
        <li>
          <strong>Resend</strong>: delivers our outbound email. Your email address is shared with
          Resend only to send messages you&rsquo;ve triggered, such as verification links.
        </li>
        <li>
          <strong>Cloudflare</strong>: hosts the application and database. Your data is processed and
          stored on Cloudflare&rsquo;s infrastructure.
        </li>
      </ul>
      <p>
        These providers process data on our behalf under their own terms and privacy policies. We
        don&rsquo;t sell your personal information to anyone.
      </p>

      <h2>What&rsquo;s visible to others</h2>
      <p>
        Most of your activity is private to your account. Some things are public{" "}
        <em>by your choice</em>: when you make a list public or share your profile, its contents
        (including your username and the titles on it) can be viewed by anyone with the link. Making a
        list private again removes public access.
      </p>

      <h2>Data retention and deletion</h2>
      <p>
        We keep your data for as long as your account exists. You can delete your account, after which
        we remove or anonymize your personal data, except where we&rsquo;re required to keep limited
        records (for example, to comply with law or resolve disputes). To request deletion or a copy
        of your data, email{" "}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, export, or delete the
        personal information we hold about you, and to object to or restrict certain processing. You
        can update much of your information directly in Settings, or contact us to exercise any of
        these rights. We won&rsquo;t discriminate against you for doing so.
      </p>

      <h2>Security</h2>
      <p>
        We take reasonable measures to protect your data: passwords are hashed, sessions are signed,
        and traffic is served over HTTPS. No system is perfectly secure, but we work to keep your
        information safe and to limit what we collect in the first place.
      </p>

      <h2>Children</h2>
      <p>
        Show Us TV isn&rsquo;t directed to children under 13 (or the minimum age of digital consent in
        your country), and we don&rsquo;t knowingly collect their personal information. If you believe
        a child has given us data, contact us and we&rsquo;ll remove it.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this policy from time to time. When we make material changes we&rsquo;ll update
        the &ldquo;Last updated&rdquo; date above, and where appropriate we&rsquo;ll let you know in
        the app or by email.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy? Email{" "}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>. See also our{" "}
        <Link to="/terms">Terms of Service</Link>.
      </p>
    </LegalLayout>
  );
}

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Show Us TV (the
        &ldquo;Service&rdquo;), a personal tracker for TV shows and movies. By creating an account or
        using the Service, you agree to these Terms. If you don&rsquo;t agree, please don&rsquo;t use
        the Service.
      </p>

      <h2>The Service</h2>
      <p>
        Show Us TV lets you follow shows and movies, mark episodes watched, keep a watchlist, rate and
        favorite titles, and build lists you can optionally share. Metadata and imagery come from
        third parties (see <Link to="/privacy">Privacy Policy</Link>). We may add, change, or remove
        features over time.
      </p>

      <h2>Eligibility</h2>
      <p>
        You must be at least 13 years old (or the minimum age of digital consent where you live) to
        use the Service. By using it, you confirm that you meet this requirement and can form a
        binding agreement with us.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You&rsquo;re responsible for keeping your password confidential and for all activity under your account.</li>
        <li>Provide accurate account information and keep your email address current so you can recover access.</li>
        <li>Notify us promptly at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if you suspect unauthorized use of your account.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>When using the Service, you agree not to:</p>
      <ul>
        <li>Break the law or infringe anyone&rsquo;s rights.</li>
        <li>Post content in comments, lists, or your profile that is harassing, hateful, threatening, or otherwise abusive.</li>
        <li>Upload malware, or attempt to disrupt, overload, or gain unauthorized access to the Service or its data.</li>
        <li>Scrape, harvest, or use automated means to access the Service in a way that burdens it or violates our providers&rsquo; terms.</li>
        <li>Reverse engineer or misuse the Service except to the extent the law expressly permits.</li>
      </ul>
      <p>We may remove content or suspend accounts that violate these Terms.</p>

      <h2>Your content</h2>
      <p>
        You keep ownership of the lists, comments, and other content you create. By posting it, you
        grant us a non-exclusive license to store, display, and share it as needed to operate the
        Service, for example, showing a list you&rsquo;ve made public to people with the link. You
        are responsible for the content you post and confirm you have the right to share it.
      </p>

      <h2>Imported data</h2>
      <p>
        If you import a history from another service such as TV Time, you confirm you have the right to
        do so. You&rsquo;re responsible for the data you bring into the Service.
      </p>

      <h2>Third-party content and attribution</h2>
      <p>
        Show and movie information, artwork, and streaming availability are provided by third parties,
        including The Movie Database (TMDB) and JustWatch, and are subject to their terms. This product
        uses the TMDB API but is not endorsed or certified by TMDB. We don&rsquo;t guarantee the
        accuracy, completeness, or availability of third-party data.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep the Service running, but we may modify, suspend, or discontinue any part of it
        at any time, and it may occasionally be unavailable for maintenance or reasons outside our
        control. The Service is provided free of charge and without a guarantee of uptime.
      </p>

      <h2>Disclaimers</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties
        of any kind, whether express or implied, including fitness for a particular purpose,
        merchantability, and non-infringement. We don&rsquo;t warrant that the Service will be
        uninterrupted, error-free, or that any data will be accurate or preserved.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Show Us TV and its operators will not be liable for any
        indirect, incidental, special, consequential, or punitive damages, or for any loss of data,
        profits, or goodwill, arising out of or related to your use of the Service. Because the Service
        is provided free of charge, our total liability for any claim relating to the Service is
        limited to the greater of the amount you paid us in the past 12 months (which is typically
        zero) or, where required by law, the applicable statutory minimum.
      </p>

      <h2>Termination</h2>
      <p>
        You can stop using the Service and delete your account at any time. We may suspend or terminate
        your access if you violate these Terms or use the Service in a way that could harm it or other
        users. Provisions that by their nature should survive termination, such as disclaimers and
        limitation of liability, will continue to apply.
      </p>

      <h2>Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. When we make material changes we&rsquo;ll update
        the &ldquo;Last updated&rdquo; date above and, where appropriate, notify you in the app or by
        email. Continuing to use the Service after changes take effect means you accept the updated
        Terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these Terms? Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. See also our{" "}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>
    </LegalLayout>
  );
}
