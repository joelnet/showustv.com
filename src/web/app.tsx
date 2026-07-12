import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Link, Outlet, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { DEFAULT_DOCUMENT_TITLE } from "./hooks";
import { api, post, ApiError } from "./api";
import { setOfflineUser, useOffline } from "./offline";
import { useBackgroundActivity } from "./activity";
import { setCacheUser } from "./hooks";
import { precacheLibrary } from "./precache";
import { Spinner, Wordmark, SiteFooter } from "./components/ui";
import { ConfirmProvider } from "./components/dialog";
import { CelebrationProvider } from "./components/celebration";
import { ToastProvider } from "./components/toast";
import { IconPlay, IconSearch, IconLibrary, IconList, IconGear, IconUser, IconDownload, IconBell } from "./components/icons";
import { useInstallPrompt, isStandalone, useUpdateReady, applyUpdate } from "./pwa";
import { useUnreadNotifications, setUnread } from "./notifications";
import { Landing } from "./pages/landing";
import { Login } from "./pages/login";
import { WelcomePage } from "./pages/welcome";
import { VerifyEmailPage } from "./pages/verify-email";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/forgot-password";
import { WatchNext, WatchSectionPage } from "./pages/watchnext";
import { SearchPage } from "./pages/search";
import { ShowPage } from "./pages/show";
import { EpisodePage } from "./pages/episode";
import { MoviePage } from "./pages/movie";
import { LibraryPage } from "./pages/library";
import { ListsPage, ListDetailPage } from "./pages/lists";
import { PublicListPage } from "./pages/public-list";
import { ProfilePage } from "./pages/profile";
import { PublicProfilePage } from "./pages/public-profile";
import { PublicLibraryPage } from "./pages/public-library";
import { MyAchievementsPage, PublicAchievementsPage } from "./pages/achievements";
import { FollowingPage } from "./pages/following";
import { NotificationsPage } from "./pages/notifications";
import { SettingsPage } from "./pages/settings";
import { ImportPage } from "./pages/import";
import { ImportHelpPage } from "./pages/import-help";
import { InstallPage } from "./pages/install";
import { AboutPage } from "./pages/about";
import { PrivacyPage, TermsPage } from "./pages/legal";

export interface User {
  id: number;
  username: string;
  tz: string;
  emailVerified: boolean;
  isAdmin: boolean;
  // True once this user's PWA install has been recorded (issue #145). Only
  // guards the install self-report in App so re-launches don't re-ping — it
  // must never gate the Install button, which stays on runtime isStandalone()
  // so it self-heals after an iOS uninstall (issue #82). Older cached users
  // may lack it — treat a missing value as false.
  installed: boolean;
  // False until the account finishes the post-signup preferences step
  // (issue #160); Shell routes such users to /welcome. Older cached users
  // may lack it — treat a missing value as onboarded (check `=== false`),
  // so an offline boot from a stale cache never strands anyone there.
  onboarded: boolean;
}

// Last-known signed-in identity, mirrored to localStorage (issue #51). On an
// offline refresh the boot /auth/me call can't reach the server, so we fall
// back to this instead of bouncing a signed-in user to /login — they keep
// navigating the app from the service-worker cache until they're back online.
// It holds only the public identity /auth/me already returns (no secrets), is
// per-browser, and is cleared on sign-out and on a real 401, so the next
// person to sign in never inherits it.
const CACHED_USER_KEY = "showustv-user";

function loadCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as unknown;
    // Validate the shape before trusting it to gate protected routes — a
    // tampered or stale-schema entry must not read as a signed-in user.
    if (u && typeof u === "object" && typeof (u as User).id === "number" && typeof (u as User).username === "string") {
      return u as User;
    }
    return null;
  } catch {
    return null; // storage disabled or corrupt — treat as logged out
  }
}

function saveCachedUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // storage disabled/full — offline boot just falls back to /login
  }
}

const AuthCtx = createContext<{ user: User | null; setUser: (u: User | null) => void }>({
  user: null,
  setUser: () => {},
});

// Tab-title reset (issue #211): a hard load of a title page — or a public
// profile (issue #219) — arrives with that name baked into <title> by the
// Worker (social previews), and those pages maintain it client-side
// (useDocumentTitle). Without this, navigating from one of them to any other
// route would leave the last show/movie/username stuck in the tab. Only the
// exact /u/:username page keeps its title — sub-paths (achievements, lists)
// don't set one, so they reset like everything else.
function DocumentTitleSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!/^\/(show|movie|episode)\//.test(pathname) && !/^\/u\/[^/]+\/?$/.test(pathname))
      document.title = DEFAULT_DOCUMENT_TITLE;
  }, [pathname]);
  return null;
}

export const useAuth = () => useContext(AuthCtx);

// Where "your profile" lives (issue #220): the shareable /u/<name> address
// everyone else sees, so clicking Profile puts the copyable URL straight in
// the address bar. The /profile fallback never renders for a signed-out
// visitor (the nav only exists inside Shell), but if it ever did, that path
// redirects to the same place anyway.
function useProfilePath(): string {
  const { user } = useAuth();
  return user ? `/u/${user.username}` : "/profile";
}

// /u/:username is everyone's profile address (issue #220). When the name is
// the signed-in user's own (case-insensitive, matching the server's COLLATE
// NOCASE username lookups), the route renders the owner view with the
// management affordances; any other name gets the read-only public view.
// Two distinct components — rather than one page branching inside — so each
// page's hooks stay unconditional.
function OwnOrPublic({ own, other }: { own: React.ReactElement; other: React.ReactElement }) {
  const { user } = useAuth();
  const { username } = useParams();
  return user && username && username.toLowerCase() === user.username.toLowerCase() ? own : other;
}

// The retired own-profile address (issue #220): old bookmarks and deep links
// to /profile land on the custom URL instead. Shell already bounced the
// signed-out to /login before this renders; the guard just keeps it total.
function ProfileRedirect({ sub = "" }: { sub?: string }) {
  const { user } = useAuth();
  return <Navigate to={user ? `/u/${user.username}${sub}` : "/login"} replace />;
}

function Shell() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // A brand-new account that hasn't finished the preferences step yet is
  // sent back to it (issue #160) — a reload or a later login resumes the
  // onboarding until "Finish Signup" completes it. Explicit `=== false`:
  // older cached users lack the flag and must never be bounced.
  if (user.onboarded === false) return <Navigate to="/welcome" replace />;
  return (
    <div className="shell">
      <Header />
      <NetBanner />
      <main className="main">
        <Outlet />
      </main>
      <SiteFooter>
        <Link to="/about">About</Link>
      </SiteFooter>
      <TabBar />
    </div>
  );
}

// Chrome for signed-out visitors on shared title pages (issue #159) and
// public profiles (issue #200): the brand header with a sign-in affordance
// instead of the signed-in app nav.
function PublicShell() {
  return (
    <div className="public-page">
      <header className="header header--public">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
          <Wordmark />
        </Link>
        <Link to="/login" className="btn btn-ghost">
          Sign in
        </Link>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

function Header() {
  const navigate = useNavigate();
  const profilePath = useProfilePath();
  const { available, ios, install } = useInstallPrompt();
  // Show the install affordance unless the app is already running installed.
  // `available` is false in standalone mode (isStandalone()), so this naturally
  // hides inside the installed PWA and returns in a browser tab after an
  // uninstall — no persisted per-user flag to go stale (issue #82). Chromium
  // additionally drops `available` once beforeinstallprompt is consumed; on iOS
  // the button just links to the /install instructions.
  const showInstall = available;
  return (
    <header className="header">
      <Link to="/" className="header-brand" aria-label="Show Us TV, home">
        <Wordmark />
      </Link>
      <nav className="header-nav" aria-label="Primary">
        <NavLink to="/" end>Watch now</NavLink>
        <NavLink to="/library">Library</NavLink>
        <NavLink to="/lists">Lists</NavLink>
        <NavLink to={profilePath}>Profile</NavLink>
      </nav>
      <form
        className="header-search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get("q") as string;
          if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <IconSearch size={16} />
        <input name="q" type="search" placeholder="Search shows & movies" aria-label="Search shows and movies" />
      </form>
      {showInstall &&
        (ios ? (
          <Link to="/install" className="header-install" aria-label="How to install the app">
            <IconDownload size={14} /> <span>Install App</span>
          </Link>
        ) : (
          <button type="button" className="header-install" onClick={install} aria-label="Install app">
            <IconDownload size={14} /> <span>Install App</span>
          </button>
        ))}
      <NotificationBell />
      <Link to="/settings" className="header-gear" aria-label="Settings">
        <IconGear />
      </Link>
      <HeaderProgress />
    </header>
  );
}

// Thin indeterminate progress sweep pinned to the header's bottom edge
// (issue #204) — a loading BAR, deliberately not a circular spinner. Visible
// while activity is syncing (the offline queue replaying) or being downloaded
// to the local cache (the precache passes); hidden otherwise. Always rendered
// so it can fade in/out; the CSS delays the fade-in so near-instant passes
// (everything already cached) never flash it.
function HeaderProgress() {
  const { syncing } = useOffline();
  const caching = useBackgroundActivity();
  const busy = syncing || caching;
  return (
    <div
      className={`header-progress${busy ? " is-busy" : ""}`}
      role="progressbar"
      aria-label="Syncing"
      aria-hidden={busy ? undefined : true}
    >
      <div className="header-progress-fill" />
    </div>
  );
}

// The bell (issue #129): unread-count badge like other social apps; clicking
// it opens the notifications page, which marks everything read.
function NotificationBell() {
  const count = useUnreadNotifications();
  const label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  return (
    <Link to="/notifications" className="header-bell" aria-label={label} title="Notifications">
      <IconBell />
      {count > 0 && (
        <span className="bell-badge" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

// Connectivity strip under the header: offline notice with the count of
// queued changes, sync progress, and a brief synced/failed confirmation.
function NetBanner() {
  const { online, pending, syncing, result, dropped } = useOffline();
  const n = (count: number, noun = "change") => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (!online)
    return (
      <div className="net-banner is-offline" role="status">
        Offline, showing saved data{pending > 0 && ` · ${n(pending)} waiting to sync`}
      </div>
    );
  if (syncing || pending > 0)
    return (
      <div className="net-banner is-syncing" role="status">
        Syncing {n(pending)}…
      </div>
    );
  if (result === "failed")
    return (
      <div className="net-banner is-failed" role="status">
        {n(dropped)} couldn&rsquo;t be synced and {dropped === 1 ? "was" : "were"} discarded
      </div>
    );
  if (result === "synced")
    return (
      <div className="net-banner is-synced" role="status">
        All changes synced ✓
      </div>
    );
  return null;
}

// New-version toast (issue #172): rendered app-wide (any page, signed in or
// out) once a fresh deploy's service worker is installed and waiting.
// Update promotes it and reloads into the new version; Later leaves this
// page as it is (the waiting worker activates on the next full app launch,
// and any later reload picks up the new client from the network anyway).
function UpdateToast() {
  const ready = useUpdateReady();
  const [dismissed, setDismissed] = useState(false);
  if (!ready || dismissed) return null;
  return (
    <div className="update-toast" role="status">
      <span>A new version is available.</span>
      <button type="button" className="btn" onClick={applyUpdate}>
        Update
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setDismissed(true)}>
        Later
      </button>
    </div>
  );
}

function TabBar() {
  const profilePath = useProfilePath();
  return (
    <nav className="tabbar" aria-label="Primary">
      <NavLink to="/" end><IconPlay /><span>Watch now</span></NavLink>
      <NavLink to="/search"><IconSearch /><span>Search</span></NavLink>
      <NavLink to="/library"><IconLibrary /><span>Library</span></NavLink>
      <NavLink to="/lists"><IconList /><span>Lists</span></NavLink>
      <NavLink to={profilePath}><IconUser /><span>Profile</span></NavLink>
    </nav>
  );
}

export function App() {
  const [user, setUserState] = useState<User | null>(null);
  const [booted, setBooted] = useState(false);

  // Persist every auth transition (login, sign-out, boot) so an offline
  // refresh can restore the signed-in user — see loadCachedUser above.
  const setUser = useCallback((u: User | null) => {
    // The page-data cache (issue #154) is per-account — drop it the moment
    // the signed-in identity changes (sign-out, or signing into a different
    // account), synchronously, before any page renders under the new user,
    // so cached pages never leak across accounts. No-op when the id is
    // unchanged (username edits, the installed flag).
    setCacheUser(u?.id ?? null);
    setUserState(u);
    saveCachedUser(u);
    // The unread badge is a module-global store — zero it on sign-out so the
    // next account on this browser never flashes the previous user's count.
    if (!u) setUnread(0);
  }, []);

  useEffect(() => {
    api<{ user: User }>("/auth/me", { allow401: true })
      .then((d) => setUser(d.user))
      .catch((err) => {
        // A genuine 401 means the session ended: clear the cached identity and
        // stay logged out. Any other failure is the network being unreachable
        // (airplane mode / server down) — fall back to the last-known user so a
        // refresh doesn't force a login the user can't complete offline.
        if (err instanceof ApiError && err.status === 401) {
          setUser(null);
        } else {
          const cached = loadCachedUser();
          if (cached) setUser(cached);
        }
      })
      .finally(() => setBooted(true));
  }, [setUser]);

  // The offline queue is per-account: tell it who is signed in so queued
  // ops never replay into a different user (and replay starts on boot).
  useEffect(() => {
    setOfflineUser(user?.id ?? null);
  }, [user]);

  // Warm the offline cache for the whole library (issue #183) once a
  // signed-in, onboarded session is known — delayed so boot traffic (auth,
  // the landing page's own data) settles first. Keyed on id + onboarded, not
  // the user object, so profile edits don't re-trigger it; precacheLibrary
  // itself dedupes concurrent runs, waits for SW control, retries when
  // connectivity returns, and skips whatever is already cached fresh.
  useEffect(() => {
    if (!user || user.onboarded === false) return;
    const t = window.setTimeout(precacheLibrary, 4000);
    return () => window.clearTimeout(t);
  }, [user?.id, user?.onboarded]);

  // Track a successful install in the activity logs (issue #145). Chromium
  // fires appinstalled only when an install actually completes (never on a
  // dismissed prompt); iOS fires nothing, so the installed app self-reports
  // on its first signed-in standalone boot instead. The server records it in
  // activity_log via POST /auth/installed (set-once, so races can't double-
  // log) and `user.installed` stops re-pings on later launches. Installs made
  // while signed out are caught by the standalone-boot path after sign-in.
  useEffect(() => {
    if (!user || user.installed) return;
    // `stale` guards the async completion: if the user signs out (or switches
    // accounts) while the ping is in flight, cleanup has run and the captured
    // `user` must not be written back into state/localStorage.
    let stale = false;
    const report = () => {
      post("/auth/installed")
        .then(() => {
          if (!stale) setUser({ ...user, installed: true });
        })
        .catch(() => {}); // best-effort — retried on the next standalone launch
    };
    if (isStandalone()) report();
    window.addEventListener("appinstalled", report);
    return () => {
      stale = true;
      window.removeEventListener("appinstalled", report);
    };
  }, [user, setUser]);

  if (!booted) return <Spinner />;

  // Logged-out visitors normally get the marketing page at "/". But when the
  // app is running installed (standalone / iOS home-screen), there's no reason
  // to re-pitch the product — send them straight to Login instead (issue #46).
  const loggedOutRoot = isStandalone() ? <Login /> : <Landing />;

  return (
    <AuthCtx.Provider value={{ user, setUser }}>
      <BrowserRouter>
        <DocumentTitleSync />
        <ConfirmProvider>
        <CelebrationProvider>
        <ToastProvider>
        <Routes>
          {/* Logged-out visitors get the marketing page at "/" (or Login when
              installed); signed-in users fall through to the Shell route below
              and land on Watch Next as before. */}
          {!user && <Route path="/" element={loggedOutRoot} />}
          <Route path="/login" element={<Login />} />
          {/* Post-signup preferences step (issue #160) — full-screen card
              like /login, outside the app Shell. Guards itself: logged-out
              visitors go to /login, onboarded users into the app. */}
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          {/* Forgot-password flow (issue #216) — public like /verify-email:
              the reset-link clicker is logged out by definition. */}
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Public TV Time export/import how-to (linked from the landing banner). */}
          <Route path="/import-help" element={<ImportHelpPage />} />
          {/* Public iOS install walkthrough (linked from the Install App button). */}
          <Route path="/install" element={<InstallPage />} />
          {/* Legal pages — public so they're reachable signed in or out (footer). */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/u/:username/lists/:id" element={<PublicListPage />} />
          {/* Shared title pages (issue #159) and user profiles (issue #200):
              signed-out visitors open these links with public chrome instead
              of bouncing to /login. Signed-in users skip these (the branch
              doesn't register) and keep the full app Shell versions below. */}
          {!user && (
            <Route element={<PublicShell />}>
              <Route path="/show/:id" element={<ShowPage />} />
              <Route path="/episode/:id" element={<EpisodePage />} />
              <Route path="/movie/:id" element={<MoviePage />} />
              <Route path="/u/:username" element={<PublicProfilePage />} />
              <Route path="/u/:username/achievements" element={<PublicAchievementsPage />} />
              <Route path="/u/:username/library" element={<PublicLibraryPage tab="shows" />} />
              <Route path="/u/:username/library/movies" element={<PublicLibraryPage tab="movies" />} />
              <Route path="/u/:username/library/anime" element={<PublicLibraryPage tab="anime" />} />
            </Route>
          )}
          <Route element={<Shell />}>
            <Route path="/" element={<WatchNext />} />
            <Route path="/watch/:key" element={<WatchSectionPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/show/:id" element={<ShowPage />} />
            <Route path="/episode/:id" element={<EpisodePage />} />
            <Route path="/movie/:id" element={<MoviePage />} />
            <Route path="/library" element={<LibraryPage tab="shows" />} />
            <Route path="/library/movies" element={<LibraryPage tab="movies" />} />
            <Route path="/library/anime" element={<LibraryPage tab="anime" />} />
            {/* The Watchlist tab folded into Watch Later subtabs under Shows
                and Movies (issue #257); old bookmarks land on the Library. */}
            <Route path="/library/watchlist" element={<Navigate to="/library" replace />} />
            <Route path="/lists" element={<ListsPage />} />
            <Route path="/lists/:id" element={<ListDetailPage />} />
            <Route path="/following" element={<FollowingPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            {/* Your profile lives at its shareable custom URL (issue #220);
                the old /profile addresses redirect so bookmarks and older
                links keep working. */}
            <Route path="/profile" element={<ProfileRedirect />} />
            <Route path="/profile/achievements" element={<ProfileRedirect sub="/achievements" />} />
            {/* Every profile gets the same app chrome as any other
                signed-in page (issue #200); your own name renders the owner
                view, anyone else's the public one (issue #220). The
                achievements pages (issue #201) split the same way: the full
                goal catalog for you, unlocked-only for everyone else. */}
            <Route path="/u/:username" element={<OwnOrPublic own={<ProfilePage />} other={<PublicProfilePage />} />} />
            <Route
              path="/u/:username/achievements"
              element={<OwnOrPublic own={<MyAchievementsPage />} other={<PublicAchievementsPage />} />}
            />
            {/* The public library (issue #245) renders the same for every
                signed-in viewer — the server gates by profile visibility and
                serves the owner their own in full, so no OwnOrPublic split:
                on your own username it doubles as the visitor preview (your
                real library, Watch Later subtabs included, stays at
                /library). */}
            <Route path="/u/:username/library" element={<PublicLibraryPage tab="shows" />} />
            <Route path="/u/:username/library/movies" element={<PublicLibraryPage tab="movies" />} />
            <Route path="/u/:username/library/anime" element={<PublicLibraryPage tab="anime" />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/import" element={<ImportPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <UpdateToast />
        </ToastProvider>
        </CelebrationProvider>
        </ConfirmProvider>
      </BrowserRouter>
    </AuthCtx.Provider>
  );
}
