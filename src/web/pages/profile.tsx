// The signed-in user's profile: watch stats, public/private toggle, email
// verification, and the lists pinned to it (add / remove / reorder).
// Public view: public-profile.tsx.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks";
import { post, put, del } from "../api";
import { watchTimeStr, fmtDateTime } from "../format";
import { ACHIEVEMENTS } from "../../shared/achievements";
import { useAuth } from "../app";
import { Spinner, Empty, ErrorNote } from "../components/ui";
import {
  IconHeart,
  IconEye,
  IconEyeSlash,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconUsers,
  IconCheck,
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
  email: string | null;
  emailVerified: boolean;
  pendingEmail: string | null;
  achievements: { id: string; unlockedAt: string }[];
  stats: WatchStats;
  lists: ProfileList[];
  otherLists: Omit<ProfileList, "posters">[];
}

// The full catalog, unlocked ones lit (issue #19). Locked entries show
// their goal as the hint — chasing them is the point.
export function AchievementGrid({ unlocked, tz }: { unlocked: Map<string, string | null>; tz?: string }) {
  return (
    <div className="ach-grid">
      {ACHIEVEMENTS.map((a) => {
        const has = unlocked.has(a.id);
        const at = unlocked.get(a.id);
        return (
          <div
            key={a.id}
            className={`ach${has ? " is-unlocked" : ""}`}
            title={has && at && tz ? `Unlocked ${fmtDateTime(at, tz)}` : a.desc}
          >
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

// Email verification (issue #13): enter an address, click the emailed link,
// confirm on the landing page, get the check mark. A verified email is what
// unlocks commenting.
function EmailVerification({ data, reload }: { data: ProfileData; reload: () => void }) {
  const [email, setEmail] = useState(data.pendingEmail ?? data.email ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await post("/profile/email", { email: email.trim() });
      setNote(`Verification link sent to ${email.trim()} — check your inbox.`);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="email-verify">
      <h2 className="section-title">Email</h2>
      {data.emailVerified && data.email ? (
        <p className="email-status">
          <span className="email-address">{data.email}</span>
          <span className="email-badge">
            <IconCheck size={13} /> Validated
          </span>
        </p>
      ) : (
        <p className="email-status">
          {data.pendingEmail
            ? `Verification pending for ${data.pendingEmail} — click the link in your inbox.`
            : "Not validated — verify your email to comment and vote."}
        </p>
      )}
      <form
        className="email-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
          required
        />
        <button type="submit" className="btn" disabled={busy || !email.trim()}>
          {data.pendingEmail && email.trim() === data.pendingEmail ? "Resend link" : data.emailVerified ? "Change email" : "Verify"}
        </button>
      </form>
      {note && <p className="email-note">{note}</p>}
      {err && <p className="email-err">{err}</p>}
    </div>
  );
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
  const { user } = useAuth();
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

      <EmailVerification data={data} reload={reload} />

      <h2 className="section-title">
        Achievements <span className="mono ach-count">({data.achievements.length}/{ACHIEVEMENTS.length})</span>
      </h2>
      <AchievementGrid unlocked={new Map(data.achievements.map((a) => [a.id, a.unlockedAt]))} tz={user!.tz} />

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
