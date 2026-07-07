import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Link, Outlet, Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "./api";
import { setOfflineUser, useOffline } from "./offline";
import { Spinner, Wordmark, SiteFooter } from "./components/ui";
import { ConfirmProvider } from "./components/dialog";
import { CelebrationProvider } from "./components/celebration";
import { IconPlay, IconSearch, IconLibrary, IconList, IconGear, IconUser, IconDownload } from "./components/icons";
import { useInstallPrompt, isStandalone } from "./pwa";
import { Landing } from "./pages/landing";
import { Login } from "./pages/login";
import { VerifyEmailPage } from "./pages/verify-email";
import { WatchNext } from "./pages/watchnext";
import { SearchPage } from "./pages/search";
import { ShowPage } from "./pages/show";
import { EpisodePage } from "./pages/episode";
import { MoviePage } from "./pages/movie";
import { LibraryPage } from "./pages/library";
import { ListsPage, ListDetailPage } from "./pages/lists";
import { PublicListPage } from "./pages/public-list";
import { ProfilePage } from "./pages/profile";
import { PublicProfilePage } from "./pages/public-profile";
import { FollowingPage } from "./pages/following";
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

export const useAuth = () => useContext(AuthCtx);

function Shell() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
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

function Header() {
  const navigate = useNavigate();
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
        <NavLink to="/following">Following</NavLink>
        <NavLink to="/profile">Profile</NavLink>
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
      <Link to="/settings" className="header-gear" aria-label="Settings">
        <IconGear />
      </Link>
    </header>
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

function TabBar() {
  return (
    <nav className="tabbar" aria-label="Primary">
      <NavLink to="/" end><IconPlay /><span>Watch now</span></NavLink>
      <NavLink to="/search"><IconSearch /><span>Search</span></NavLink>
      <NavLink to="/library"><IconLibrary /><span>Library</span></NavLink>
      <NavLink to="/lists"><IconList /><span>Lists</span></NavLink>
      <NavLink to="/profile"><IconUser /><span>Profile</span></NavLink>
    </nav>
  );
}

export function App() {
  const [user, setUserState] = useState<User | null>(null);
  const [booted, setBooted] = useState(false);

  // Persist every auth transition (login, sign-out, boot) so an offline
  // refresh can restore the signed-in user — see loadCachedUser above.
  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    saveCachedUser(u);
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

  if (!booted) return <Spinner />;

  // Logged-out visitors normally get the marketing page at "/". But when the
  // app is running installed (standalone / iOS home-screen), there's no reason
  // to re-pitch the product — send them straight to Login instead (issue #46).
  const loggedOutRoot = isStandalone() ? <Login /> : <Landing />;

  return (
    <AuthCtx.Provider value={{ user, setUser }}>
      <BrowserRouter>
        <ConfirmProvider>
        <CelebrationProvider>
        <Routes>
          {/* Logged-out visitors get the marketing page at "/" (or Login when
              installed); signed-in users fall through to the Shell route below
              and land on Watch Next as before. */}
          {!user && <Route path="/" element={loggedOutRoot} />}
          <Route path="/login" element={<Login />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          {/* Public TV Time export/import how-to (linked from the landing banner). */}
          <Route path="/import-help" element={<ImportHelpPage />} />
          {/* Public iOS install walkthrough (linked from the Install App button). */}
          <Route path="/install" element={<InstallPage />} />
          {/* Legal pages — public so they're reachable signed in or out (footer). */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/u/:username/lists/:id" element={<PublicListPage />} />
          <Route path="/u/:username" element={<PublicProfilePage />} />
          <Route element={<Shell />}>
            <Route path="/" element={<WatchNext />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/show/:id" element={<ShowPage />} />
            <Route path="/episode/:id" element={<EpisodePage />} />
            <Route path="/movie/:id" element={<MoviePage />} />
            <Route path="/library" element={<LibraryPage tab="shows" />} />
            <Route path="/library/movies" element={<LibraryPage tab="movies" />} />
            <Route path="/library/anime" element={<LibraryPage tab="anime" />} />
            <Route path="/library/watchlist" element={<LibraryPage tab="watchlist" />} />
            <Route path="/lists" element={<ListsPage />} />
            <Route path="/lists/:id" element={<ListDetailPage />} />
            <Route path="/following" element={<FollowingPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/import" element={<ImportPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </CelebrationProvider>
        </ConfirmProvider>
      </BrowserRouter>
    </AuthCtx.Provider>
  );
}
