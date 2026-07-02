// The signed-in user's profile: watch stats, public/private toggle, and the
// lists pinned to it (add / remove / reorder). Public view: public-profile.tsx.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { post, put, del } from "../api";
import { watchTimeStr } from "../format";
import { Spinner, Empty, ErrorNote } from "../components/ui";
import {
  IconHeart,
  IconEye,
  IconEyeSlash,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconUsers,
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
  stats: WatchStats;
  lists: ProfileList[];
  otherLists: Omit<ProfileList, "posters">[];
}

export function StatsGrid({ stats }: { stats: WatchStats }) {
  return (
    <div className="profile-stats">
      <div className="stat-card">
        <span className="stat-value mono">{stats.episodesWatched.toLocaleString("en-US")}</span>
        <span className="stat-label">Episodes watched</span>
      </div>
      <div className="stat-card">
        <span className="stat-value">{watchTimeStr(stats.minutesWatched)}</span>
        <span className="stat-label">TV time</span>
      </div>
      <div className="stat-card">
        <span className="stat-value mono">{stats.showsWatched.toLocaleString("en-US")}</span>
        <span className="stat-label">Shows watched</span>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const { data, loading, error, reload } = useApi<ProfileData>("/profile");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (loading) return <Spinner />;
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

  async function move(index: number, delta: number) {
    const ids = data!.lists.map((l) => l.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    await act(() => put("/profile/lists/order", { ids }))();
  }

  const shareUrl = `${window.location.origin}/u/${data.username}`;

  return (
    <div>
      <div className="list-head">
        <h1 className="page-title">Profile</h1>
        <div className="list-head-actions">
          {/* The mobile tab bar keeps its 5 slots — this is the Friends
              entry point on small screens (desktop also has it in the header nav). */}
          <Link className="btn btn-ghost" to="/friends">
            <IconUsers size={15} /> Friends
          </Link>
          <button
            className="btn btn-ghost"
            disabled={busy}
            aria-pressed={data.isPublic}
            title={data.isPublic ? "Public — anyone with the link can view" : "Private — only you can view"}
            onClick={act(() => put("/profile/visibility", { public: !data.isPublic }))}
          >
            {data.isPublic ? <IconEye size={15} /> : <IconEyeSlash size={15} />}
            {data.isPublic ? "Public" : "Private"}
          </button>
        </div>
      </div>
      <p className="settings-user">
        <strong>{data.username}</strong>
        {!data.isPublic && " · your profile is private — only you can see it"}
      </p>

      {data.isPublic && (
        <p className="share-note">
          Anyone with this link can view: <a href={`/u/${data.username}`}>{shareUrl}</a>{" "}
          <button
            className="link-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(shareUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
        </p>
      )}

      <StatsGrid stats={data.stats} />

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
                  {!l.is_shared && " · private — hidden on your public profile"}
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
            if (id) act(() => post("/profile/lists", { id }))();
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
