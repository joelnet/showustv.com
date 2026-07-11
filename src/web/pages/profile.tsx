// The signed-in user's own profile. It lives at the shareable custom URL —
// /u/<username>, the same address visitors use (issue #220) — so the address
// bar always shows the link worth copying; the old /profile path just
// redirects here (app.tsx). On top of everything visitors see (stats,
// achievements, activity, conversations), the owner gets the management
// affordances: the username editor, the public/private toggle, the activity
// eye toggle, and the lists pinned to the profile (add / remove / reorder).
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
import { Empty, ErrorNote, Slate } from "../components/ui";
import { ShareButton } from "../components/share";
import { ProfileSkeleton } from "../components/skeleton";
import {
  IconHeart,
  IconEye,
  IconEyeSlash,
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

// One row of the recent-activity feed (issue #202), already gated
// server-side: hidden sections arrive as an empty array.
export interface ActivityItem {
  kind: "show_added" | "show_saved" | "episode_watched" | "movie_watched" | "rated";
  ts: string;
  score: number | null; // set for 'rated' only
  target: {
    type: MediaType;
    id: number;
    title: string; // show/movie title; for episodes, the show's title
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

// Verb per activity kind. 'show_saved' carries a " for later" tail after the
// title so the sentence reads "Saved <show> for later".
const ACTIVITY_VERBS: Record<ActivityItem["kind"], string> = {
  show_added: "Started following",
  show_saved: "Saved",
  episode_watched: "Watched",
  movie_watched: "Watched",
  rated: "Rated",
};

// Recent activity (issue #202): the 20 most recent library/rating actions,
// each row linking to its show/movie/episode page. The server already gated
// visibility — a hidden section arrives here as an empty array, and
// `visible` (the owner's eye-toggle state) arrives ONLY for the owner, so
// its presence doubles as the "render the toggle" signal. Non-owners with
// nothing to show get no section at all; the owner always gets it, otherwise
// the toggle would vanish along with the rows it controls.
export function ProfileActivity({
  items,
  visible,
  busy,
  onToggle,
}: {
  items: ActivityItem[];
  visible?: boolean; // undefined = viewer isn't the owner
  busy?: boolean;
  onToggle?: (next: boolean) => void;
}) {
  const isOwner = visible !== undefined;
  if (!isOwner && !items.length) return null;
  return (
    <>
      <h2 className="section-title profile-activity-title">
        Activity
        {isOwner && (
          <>
            <button
              className="btn btn-ghost profile-privacy-btn"
              disabled={busy}
              aria-pressed={visible}
              aria-label={visible ? "Hide your activity from visitors" : "Show your activity to visitors"}
              title={
                visible
                  ? "Visible to anyone who can see this profile. Click to hide"
                  : "Hidden: visitors don't see your activity. Click to show"
              }
              onClick={() => onToggle?.(!visible)}
            >
              {visible ? <IconEye size={15} /> : <IconEyeSlash size={15} />}
            </button>
            {!visible && (
              <span className="profile-activity-note" role="status">
                Hidden — only you can see this
              </span>
            )}
          </>
        )}
      </h2>
      {!items.length ? (
        <p className="profile-activity-empty">Nothing yet — it fills in as you follow and watch things.</p>
      ) : (
        <ul className="profile-comments profile-activity">
          {items.map((a, i) => (
            <li key={i}>
              <p className="profile-comment-meta">
                {ACTIVITY_VERBS[a.kind]}{" "}
                <Link
                  to={mediaPath(a.target.type, a.target.id, a.target.type === "episode" ? a.target.episodeTitle : a.target.title)}
                >
                  {a.target.title}
                </Link>
                {a.target.type === "episode" && a.target.season != null && a.target.episode != null && (
                  <>
                    {" "}
                    <Slate season={a.target.season} number={a.target.episode} />
                  </>
                )}
                {a.kind === "show_saved" && " for later"}
                {a.kind === "rated" && a.score != null && <span className="mono"> {a.score}/10</span>}
                <span className="mono"> · {fmtAgo(a.ts)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
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
  activity?: ActivityItem[]; // optional: tolerates cached pre-#202 payloads
  activityPublic?: boolean;
  comments: ProfileComment[];
}

export function ProfilePage() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<ProfileData>("/profile");
  // The visitor-facing feed sections (activity, issue #202; conversations,
  // issue #16) come from the same public payload /u/<name> serves everyone —
  // fetched alongside /profile so this page shows exactly what visitors get,
  // plus the eye toggle the server includes only for the owner. Canonical
  // casing from the auth context, not the URL param, keys the cache entry
  // consistently however the address was typed.
  const pubPath = user ? `/public/profile/${encodeURIComponent(user.username)}` : null;
  const { data: pub, reload: reloadPub } = useApi<OwnPublicData>(pubPath);
  const [busy, setBusy] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // Keep the tab title the Worker baked in for /u/ hard loads (issue #219)
  // once the SPA takes over, matching the public view of the same URL —
  // DocumentTitleSync only spares this route from the default reset.
  useDocumentTitle(data && `@${data.username}`);

  // Cache hygiene mirrored from public-profile.tsx: the owner's payload is
  // no-store on the wire when the profile is private or the activity hidden
  // (issues #158/#184/#202) — drop the in-memory copy too so nothing
  // warm-paints it later.
  useEffect(() => {
    if (pubPath && pub && (pub.private || pub.activityPublic === false)) dropCached(pubPath);
  }, [pub, pubPath]);

  // Owner-only (issue #202): flip whether visitors see the Activity section.
  // The server re-checks the session; this just persists and refetches so
  // the section reflects the stored state, not an optimistic guess.
  const toggleActivity = async (next: boolean) => {
    setActivityBusy(true);
    setActivityError(null);
    try {
      await put("/profile/activity-visibility", { public: next });
      reloadPub();
    } catch (e: any) {
      setActivityError(e.message);
    } finally {
      setActivityBusy(false);
    }
  };

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
          you nothing. The pencil beside it (issue #182) toggles the inline
          rename form below; then the privacy toggle, an icon-only button
          (eye = public, lock = private, matching the public page's lock
          teaser) with the state spelled out alongside, so the icon never has
          to carry the meaning alone. */}
      <div className="profile-head">
        <h1 className="page-title">{data.username}</h1>
        <button
          className="btn btn-ghost profile-edit-btn"
          disabled={usernameBusy}
          aria-label="Edit username"
          title="Edit username"
          aria-expanded={editingUsername}
          onClick={() => setEditingUsername((v) => !v)}
        >
          <IconPencil size={15} />
        </button>
        <div className="profile-privacy">
          <button
            className="btn btn-ghost profile-privacy-btn"
            disabled={busy}
            aria-pressed={data.isPublic}
            aria-label={data.isPublic ? "Make profile private" : "Make profile public"}
            title={
              data.isPublic
                ? "Make profile private: only you can see it"
                : "Make profile public: anyone with the link can see it"
            }
            onClick={act(() => put("/profile/visibility", { public: !data.isPublic }))}
          >
            {data.isPublic ? <IconEye size={15} /> : <IconLock size={15} />}
          </button>
          <span className="profile-privacy-note" role="status">
            Your profile is {data.isPublic ? "public" : "private"}
          </span>
        </div>
      </div>

      {/* The shareable address, flat under the username like a handle (issue
          #179) — no boxed panel, no separate copy button. The Share button
          (issue #147) sits right beside it; where the browser lacks native
          share it falls back to copying the link, which is why the dedicated
          "Copy link" affordance could go. Hidden while private: the link
          would only show visitors the teaser. */}
      {data.isPublic && (
        <p className="profile-url">
          <Link to={`/u/${data.username}`}>{`${window.location.host}/u/${data.username}`}</Link>
          <ShareButton
            variant="link"
            title={`${data.username} on Show Us TV`}
            text={`See what ${data.username} has been watching on Show Us TV.`}
            path={`/u/${data.username}`}
          />
        </p>
      )}

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
          so this page doubles as the preview — with the owner-only eye
          toggle on Activity. Waits on that second fetch (it pops in rather
          than blocking the page); offline with nothing cached it simply
          stays absent. */}
      {pub && (
        <>
          <ProfileActivity
            items={pub.activity ?? []}
            visible={pub.activityPublic}
            busy={activityBusy}
            onToggle={toggleActivity}
          />
          {activityError && <ErrorNote message={activityError} />}
          <ProfileComments comments={pub.comments ?? []} />
        </>
      )}

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
