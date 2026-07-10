// The signed-in user's profile: watch stats, public/private toggle, and the
// lists pinned to it (add / remove / reorder). Email verification lives on the
// Settings page (settings.tsx). Public view: public-profile.tsx.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { post, put, del } from "../api";
import { watchTimeStr, fmtDateTime } from "../format";
import { ACHIEVEMENTS } from "../../shared/achievements";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { Empty, ErrorNote } from "../components/ui";
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

// Only the earned achievements, lit up (issue #19, #86). The locked catalog
// is clutter on your own profile — a brag wall, not a checklist. Kept in
// catalog order (grouped by category) so it stays visually coherent.
export function AchievementGrid({ unlocked, tz }: { unlocked: Map<string, string | null>; tz?: string }) {
  const earned = ACHIEVEMENTS.filter((a) => unlocked.has(a.id));
  return (
    <div className="ach-grid">
      {earned.map((a) => {
        const at = unlocked.get(a.id);
        return (
          <div key={a.id} className="ach is-unlocked" title={at && tz ? `Unlocked ${fmtDateTime(at, tz)}` : a.desc}>
            <span className="ach-emoji" aria-hidden="true">
              {a.emoji}
            </span>
            <span className="ach-title">{a.title}</span>
            <span className="ach-desc">{a.desc}</span>
          </div>
        );
      })}
    </div>
  );
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

export function ProfilePage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<ProfileData>("/profile");
  const [busy, setBusy] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameBusy, setUsernameBusy] = useState(false);

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

      <StatsGrid stats={data.stats} />

      <h2 className="section-title">
        Achievements <span className="mono ach-count">({data.achievements.length}/{ACHIEVEMENTS.length})</span>
      </h2>
      {data.achievements.length ? (
        <AchievementGrid unlocked={new Map(data.achievements.map((a) => [a.id, a.unlockedAt]))} tz={user!.tz} />
      ) : (
        <Empty title="No achievements yet" hint="Watch episodes, post comments, and build lists to start earning them." />
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
