import { createContext, useContext, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Link, Outlet, Navigate, useNavigate } from "react-router-dom";
import { api } from "./api";
import { Spinner, Wordmark } from "./components/ui";
import { ConfirmProvider } from "./components/dialog";
import { IconPlay, IconSearch, IconLibrary, IconList, IconGear, IconUser } from "./components/icons";
import { Landing } from "./pages/landing";
import { Login } from "./pages/login";
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
import { SettingsPage } from "./pages/settings";
import { AboutPage } from "./pages/about";

export interface User {
  id: number;
  username: string;
  tz: string;
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
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <span>
          This product uses the <a href="https://www.themoviedb.org">TMDB</a> API but is not endorsed or
          certified by TMDB. <Link to="/about">About</Link>
        </span>
      </footer>
      <TabBar />
    </div>
  );
}

function Header() {
  const navigate = useNavigate();
  return (
    <header className="header">
      <Link to="/" className="header-brand" aria-label="Show Us TV — home">
        <Wordmark />
      </Link>
      <nav className="header-nav" aria-label="Primary">
        <NavLink to="/" end>Watch next</NavLink>
        <NavLink to="/library">Library</NavLink>
        <NavLink to="/lists">Lists</NavLink>
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
      <Link to="/settings" className="header-gear" aria-label="Settings">
        <IconGear />
      </Link>
    </header>
  );
}

function TabBar() {
  return (
    <nav className="tabbar" aria-label="Primary">
      <NavLink to="/" end><IconPlay /><span>Watch next</span></NavLink>
      <NavLink to="/search"><IconSearch /><span>Search</span></NavLink>
      <NavLink to="/library"><IconLibrary /><span>Library</span></NavLink>
      <NavLink to="/lists"><IconList /><span>Lists</span></NavLink>
      <NavLink to="/profile"><IconUser /><span>Profile</span></NavLink>
    </nav>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    api<{ user: User }>("/auth/me", { allow401: true })
      .then((d) => setUser(d.user))
      .catch(() => {})
      .finally(() => setBooted(true));
  }, []);

  if (!booted) return <Spinner />;

  return (
    <AuthCtx.Provider value={{ user, setUser }}>
      <BrowserRouter>
        <ConfirmProvider>
        <Routes>
          {/* Logged-out visitors get the marketing page at "/"; signed-in users fall
              through to the Shell route below and land on Watch Next as before. */}
          {!user && <Route path="/" element={<Landing />} />}
          <Route path="/login" element={<Login />} />
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
            <Route path="/library/watchlist" element={<LibraryPage tab="watchlist" />} />
            <Route path="/lists" element={<ListsPage />} />
            <Route path="/lists/:id" element={<ListDetailPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </ConfirmProvider>
      </BrowserRouter>
    </AuthCtx.Provider>
  );
}
