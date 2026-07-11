// The signed-in user's own profile. It lives at the shareable custom URL —
// /u/<username>, the same address visitors use (issue #220) — so the address
// bar always shows the link worth copying; the old /profile path just
// redirects here (app.tsx). On top of everything visitors see (stats,
// achievements, conversations), the owner gets the management
// affordances: the username editor, the public/private toggle,
// and the lists pinned to the profile (add / remove / reorder).
// Email verification lives on the Settings page (settings.tsx). Visitors'
// view: public-profile.tsx, which reuses the section components defined here.
// The achievements grid lives on its own page (achievements.tsx, issue #201)
// — here it's just a linked count.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi, useDocumentTitle, dropCached } from "../hooks";
import { api, post, put, del } from "../api";
import { watchTimeStr, fmtAgo, fmtDateTime } from "../format";
import { mediaPath, type MediaType } from "../paths";
import { ACHIEVEMENTS } from "../../shared/achievements";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { useToast } from "../components/toast";
import { Empty, ErrorNote, Slate } from "../components/ui";
import { TileSection, type TileItem } from "../components/tiles";
import { ShareButton } from "../components/share";
import { ProfileSkeleton } from "../components/skeleton";
import {
  IconHeart,
  IconEye,
  IconLock,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconPlay,
  IconClock,
  IconFilm,
  IconPencil,
  IconChevron,
} from "../components/icons";

export interface WatchStats {
  episodesWatched: number;
  showsWatched: number;
  minutesWatched: number;
}
interface ProfileList {
  id: number;
  name: string;
  kind: "custom" | "favorites";
  is_shared: number;
  count: number;
  posters: string[];
}
interface ProfileData {
  username: string;
  isPublic: boolean;
  achievements: { id: string; unlockedAt: string }[];
  stats: WatchStats;
  followingCount: number;
  followersCount: number;
  lists: ProfileList[];
  otherLists: Omit<ProfileList, "posters">[];
}

// Rename the auto-assigned handle (issue #23). Sign-up gives a random
// username; this lets the user change it, updating the auth context so the
// rest of the app (share links, etc.) reflects it immediately. Just the
// inline form: the trigger is the pencil button in the profile header (issue
// #182), and the parent mounts this only while editing, so the input and any
// error start fresh each time it opens. `busy` lives in the parent so the
// pencil can't unmount the form (and eat the error) mid-save.
function UsernameEditor({
  username,
  reload,
  close,
  busy,
  setBusy,
}: {
  username: string;
  reload: () => void;
  close: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState(username);
  const [err, setErr] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (next === username) {
      close();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await put("/profile/username", { username: next });
      if (user) setUser({ ...user, username: r.username });
      close();
      reload();
      // The page's address contains the name (issue #220), so a successful
      // rename moves to the new URL — otherwise the router would treat the
      // old address as someone else's (now nonexistent) profile. Replace,
      // not push: Back shouldn't step onto a dead URL this action created.
      navigate(`/u/${r.username}`, { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="username-form" onSubmit={save}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        minLength={3}
        maxLength={20}
        pattern="[A-Za-z0-9_]+"
        aria-label="Username"
        autoFocus
        required
      />
      <button type="submit" className="btn" disabled={busy}>
        Save
      </button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
        Cancel
      </button>
      {err && <span className="email-err">{err}</span>}
    </form>
  );
}

export function StatsGrid({ stats }: { stats: WatchStats }) {
  return (
    <div className="profile-stats">
      <div className="stat-card">
        <span className="stat-icon" aria-hidden="true">
          <IconPlay size={16} />
        </span>
        <span className="stat-value mono">{stats.episodesWatched.toLocaleString("en-US")}</span>
        <span className="stat-label">Episodes watched</span>
      </div>
      <div className="stat-card">
        <span className="stat-icon" aria-hidden="true">
          <IconClock size={16} />
        </span>
        <span className="stat-value">{watchTimeStr(stats.minutesWatched)}</span>
        <span className="stat-label">TV time</span>
      </div>
      <div className="stat-card">
        <span className="stat-icon" aria-hidden="true">
          <IconFilm size={16} />
        </span>
        <span className="stat-value mono">{stats.showsWatched.toLocaleString("en-US")}</span>
        <span className="stat-label">Shows watched</span>
      </div>
    </div>
  );
}

// ---------- Sections shared with the public view (public-profile.tsx) ----------

// The watch-history rows (issue #245): Shows, Movies, and Anime as Watch-Now-
// style side-scrolling tile rows, each already deduped server-side to one
// tile per show (the latest-watched episode) so a binge can't flood a row.
// Rendered ABOVE Achievements on both profile views. Each heading opens the
// matching library tab — `base` is the owner's own /library on their page,
// /u/:username/library (the public library, issue #245) for visitors.
// Visibility rides the profile gate alone — no per-section toggle: the
// server only puts `history` in payloads it already deemed visible, and an
// all-empty history renders nothing at all.
export interface ProfileHistoryData {
  shows: TileItem[];
  movies: TileItem[];
  anime: TileItem[];
}

export function ProfileHistory({ history, base }: { history: ProfileHistoryData; base: string }) {
  if (!history.shows.length && !history.movies.length && !history.anime.length) return null;
  return (
    <div className="wn-home profile-history">
      <TileSection title="Shows" to={base} items={history.shows} />
      <TileSection title="Movies" to={`${base}/movies`} items={history.movies} />
      <TileSection title="Anime" to={`${base}/anime`} items={history.anime} />
    </div>
  );
}

export interface ProfileComment {
  body: string | null; // null for anonymous visitors — metadata only
  createdAt: string;
  target: {
    type: MediaType;
    id: number;
    title: string | null;
    season: number | null;
    episode: number | null;
    episodeTitle: string | null;
  };
}

// Recent comment activity (issue #16): what shows this user is talking
// about, each row linking into the thread's page. Anonymous visitors see
// metadata only (no bodies — the server withholds them).
export function ProfileComments({ comments }: { comments: ProfileComment[] }) {
  if (!comments.length) return null;
  return (
    <>
      <h2 className="section-title">Conversations</h2>
      <ul className="profile-comments">
        {comments.map((c, i) => (
          <li key={i}>
            {c.body != null && <p className="profile-comment-body">{c.body}</p>}
            <p className="profile-comment-meta">
              {c.body != null ? "on" : "commented on"}{" "}
              <Link to={mediaPath(c.target.type, c.target.id, c.target.type === "episode" ? c.target.episodeTitle : c.target.title)}>
                {c.target.title}
              </Link>{" "}
              {c.target.type === "episode" && c.target.season != null && c.target.episode != null && (
                <Slate season={c.target.season} number={c.target.episode} />
              )}
              <span className="mono"> · {fmtAgo(c.createdAt)}</span>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

interface ActivityRow {
  ts: string;
  method: string;
  route: string;
  path: string;
  status: number;
}

// Admin-only (issues #17/#18): the user's recent audit trail from
// activity_log, plus the shadow-ban toggle. The server re-checks is_admin
// on every call; this render gate is UX only.
export function AdminTools({ username, tz }: { username: string; tz: string }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [banned, setBanned] = useState<boolean | null>(null); // null until flags load
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBanned(null);
    api<{ user: { shadowBanned: boolean } }>(`/admin/users/${encodeURIComponent(username)}`)
      .then((d) => live && setBanned(d.user.shadowBanned))
      .catch(() => {}); // no toggle is fine (e.g. offline)
    return () => {
      live = false;
    };
  }, [username]);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ activity: ActivityRow[] }>(`/admin/users/${encodeURIComponent(username)}/activity`);
      setRows(r.activity);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleBan = async () => {
    const next = !banned;
    const yes = await confirm({
      title: next ? `Shadow ban ${username}?` : `Lift ${username}'s shadow ban?`,
      message: next
        ? "Their comments become invisible to everyone else, but they'll keep seeing their own posts as if nothing happened. They are not notified."
        : "Their comments become visible to everyone again.",
      confirmLabel: next ? "Shadow ban" : "Lift ban",
      danger: next,
    });
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      const r = await put(`/admin/users/${encodeURIComponent(username)}/shadow-ban`, { banned: next });
      setBanned(r.shadowBanned);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-tools">
      {banned != null && (
        <button
          className={`btn btn-ghost${banned ? " btn-danger" : ""}`}
          disabled={busy}
          title={banned ? "Shadow banned: comments hidden from everyone else" : "Comments visible normally"}
          onClick={toggleBan}
        >
          {banned ? "Shadow banned (lift?)" : "Shadow ban"}
        </button>
      )}
      {rows === null ? (
        <button className="btn btn-ghost" disabled={busy} onClick={load}>
          <IconEye size={15} /> View activity log
        </button>
      ) : (
        <>
          <h2 className="section-title">Activity log (admin view)</h2>
          {rows.length === 0 ? (
            <p className="admin-empty">No recorded activity.</p>
          ) : (
            <ul className="admin-activity mono">
              {rows.map((r, i) => (
                <li key={i}>
                  <span className="admin-activity-ts">{fmtDateTime(r.ts, tz)}</span>
                  <span className={`admin-activity-status${r.status >= 400 ? " is-err" : ""}`}>{r.status}</span>
                  <span>
                    {r.method} {r.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-ghost" onClick={() => setRows(null)}>
            Hide activity log
          </button>
        </>
      )}
      {error && <ErrorNote message={error} />}
    </div>
  );
}

// ---------- The owner's page ----------

// The slice of the /public/profile payload this page renders alongside the
// /profile data. The server always serves the owner their own full profile
// (issues #158/#184), so unlike public-profile.tsx there is no teaser shape
// to discriminate here.
interface OwnPublicData {
  private?: boolean;
  history?: ProfileHistoryData; // optional: tolerates cached pre-#245 payloads
  comments: ProfileComment[];
}

export function ProfilePage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<ProfileData>("/profile");
  // The visitor-facing feed sections (conversations, issue #16) come from
  // the same public payload /u/<name> serves everyone — fetched alongside
  // /profile so this page shows exactly what visitors get. Canonical
  // casing from the auth context, not the URL param, keys the cache entry
  // consistently however the address was typed.
  const pubPath = user ? `/public/profile/${encodeURIComponent(user.username)}` : null;
  const { data: pub } = useApi<OwnPublicData>(pubPath);
  const [busy, setBusy] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameBusy, setUsernameBusy] = useState(false);

  // Keep the tab title the Worker baked in for /u/ hard loads (issue #219)
  // once the SPA takes over, matching the public view of the same URL —
  // DocumentTitleSync only spares this route from the default reset.
  useDocumentTitle(data && `@${data.username}`);

  // Cache hygiene mirrored from public-profile.tsx: the owner's payload is
  // no-store on the wire when the profile is private (issues #158/#184) —
  // drop the in-memory copy too so nothing warm-paints it later.
  useEffect(() => {
    if (pubPath && pub && pub.private) dropCached(pubPath);
  }, [pub, pubPath]);

  if (loading) return <ProfileSkeleton action />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
      reload();
    } finally {
      setBusy(false);
    }
  };

  // The privacy eye is icon-only (issue #244) — no status text beside it —
  // so the toast is what tells the user which state they just landed in.
  // It fires only after the PUT succeeds; a failure toasts the error instead
  // of claiming a state change that didn't persist.
  const togglePrivacy = async () => {
    const next = !data!.isPublic;
    setBusy(true);
    try {
      await put("/profile/visibility", { public: next });
      reload();
      toast(next ? "Your profile is now public" : "Your profile is now private");
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't update your profile", "error");
    } finally {
      setBusy(false);
    }
  };

  // Pinning a private list to the profile offers to publish it — a private
  // list stays hidden on the public profile otherwise (issue #33). Declining
  // still pins it (shown with a "private — hidden" note); dismissing aborts.
  async function addListToProfile(id: number) {
    const list = data!.otherLists.find((l) => l.id === id);
    if (!list) return;
    let makePublic = false;
    if (!list.is_shared) {
      const res = await confirm({
        title: `Add “${list.name}” to your profile`,
        message: "This list is private, so it won’t show on your public profile. Make it public now?",
        confirmLabel: "Make public",
        cancelLabel: "Keep private",
      });
      if (res === null) return; // dismissed
      makePublic = res;
    }
    setBusy(true);
    try {
      if (makePublic) await put(`/lists/${id}/visibility`, { public: true });
      await post("/profile/lists", { id });
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: number) {
    const ids = data!.lists.map((l) => l.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    await act(() => put("/profile/lists/order", { ids }))();
  }

  return (
    <div>
      {/* The username is the page title (issue #162) — a "Profile" heading told
          you nothing. Bare glyphs beside it (issue #241, no button chrome):
          share first — it shares/copies this page's address, which is the
          profile URL (issue #220), so the old visible-URL row could go —
          then the rename pencil (issue #182) that toggles the inline form
          below. The privacy toggle (eye = public, lock = private, matching
          the public page's lock teaser) sits alone at the far right of the
          row (issue #244) — no status text; aria-label/title still spell the
          state out, and toggling toasts the new state. Share is hidden while
          private: the link would only show visitors the teaser. */}
      <div className="profile-head">
        <h1 className="page-title">{data.username}</h1>
        {data.isPublic && (
          <ShareButton
            variant="icon"
            title={`${data.username} on Show Us TV`}
            text={`See what ${data.username} has been watching on Show Us TV.`}
            path={`/u/${data.username}`}
          />
        )}
        <button
          className="icon-btn"
          disabled={usernameBusy}
          aria-label="Edit username"
          title="Edit username"
          aria-expanded={editingUsername}
          onClick={() => setEditingUsername((v) => !v)}
        >
          <IconPencil size={15} />
        </button>
        <button
          className="icon-btn profile-privacy"
          disabled={busy}
          aria-pressed={data.isPublic}
          aria-label={data.isPublic ? "Your profile is public. Make it private" : "Your profile is private. Make it public"}
          title={
            data.isPublic
              ? "Your profile is public: anyone with the link can see it. Click to make it private"
              : "Your profile is private: only you can see it. Click to make it public"
          }
          onClick={togglePrivacy}
        >
          {data.isPublic ? <IconEye size={15} /> : <IconLock size={15} />}
        </button>
      </div>

      {editingUsername && (
        <UsernameEditor
          username={data.username}
          reload={reload}
          close={() => setEditingUsername(false)}
          busy={usernameBusy}
          setBusy={setUsernameBusy}
        />
      )}

      {/* Following/Followers counts (issue #130). The header nav dropped its
          Following link, so this row is the entry point to /following on every
          screen size (the mobile tab bar keeps its 5 slots). The ?? 0 tolerates
          an offline-cached /profile body from before these fields existed. */}
      <p className="profile-follow-counts">
        <Link to="/following">
          <strong className="mono">{(data.followingCount ?? 0).toLocaleString("en-US")}</strong> Following
        </Link>
        <Link to="/following">
          <strong className="mono">{(data.followersCount ?? 0).toLocaleString("en-US")}</strong> Followers
        </Link>
      </p>

      {/* Admins keep the same tools on their own page that they get on
          anyone's — parity with the public view this page replaced at
          /u/<name> (issue #220). */}
      {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}

      <StatsGrid stats={data.stats} />

      {/* Watch history rows (issue #245), above Achievements. From the public
          payload like the feed sections below — so this doubles as the
          visitor preview — but the headings link to the owner's own /library
          tabs: that page (with the watchlist) is the useful one here. */}
      {pub?.history && <ProfileHistory history={pub.history} base="/library" />}

      {/* The grid moved to its own page (issue #201) — the heading itself is
          now the link, with the earned/total count, so the profile stays
          tidy. Zero earned still links out: the page doubles as the goal
          catalog, so it answers "how do I get one?" better than a hint. */}
      <h2 className="section-title">
        <Link to={`/u/${data.username}/achievements`} className="ach-page-link">
          Achievements{" "}
          <span className="mono ach-count">
            ({data.achievements.length}/{ACHIEVEMENTS.length})
          </span>
          <IconChevron size={11} />
        </Link>
      </h2>

      {/* What visitors see below the fold, straight from the public payload,
          so this page doubles as the preview. Waits on that second fetch (it
          pops in rather than blocking the page); offline with nothing cached
          it simply stays absent. */}
      {pub && <ProfileComments comments={pub.comments ?? []} />}

      <h2 className="section-title">Lists on your profile</h2>
      {!data.lists.length ? (
        <Empty title="No lists on your profile yet" hint="Pick one of your lists below to show it off." />
      ) : (
        <ul className="list-items">
          {data.lists.map((l, i) => (
            <li key={l.id}>
              <span className="mono list-pos">{i + 1}</span>
              <Link to={`/lists/${l.id}`} className="profile-list-link">
                <span className="list-name">
                  {l.kind === "favorites" && <IconHeart size={13} />} {l.name}
                </span>
                <span className="mono list-count">
                  {l.count} {l.count === 1 ? "title" : "titles"}
                  {!l.is_shared && " · private, hidden on your public profile"}
                </span>
              </Link>
              <div className="list-item-actions">
                <button className="btn btn-ghost" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <IconArrowUp size={14} />
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy || i === data.lists.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  <IconArrowDown size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-danger"
                  disabled={busy}
                  onClick={act(() => del(`/profile/lists/${l.id}`))}
                  aria-label={`Remove ${l.name} from profile`}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.otherLists.length > 0 && (
        <select
          className="add-to-list profile-add-list"
          aria-label="Add a list to your profile"
          value=""
          disabled={busy}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (id) addListToProfile(id);
          }}
        >
          <option value="">Add a list to your profile…</option>
          {data.otherLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.count})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
