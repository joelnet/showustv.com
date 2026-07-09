// Public, read-only profile — reachable without an account at /u/:username
// when the owner has made their profile public. Shows watch stats plus the
// lists they pinned (public lists only). Signed-in visitors also get a
// follow/unfollow affordance here.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, post, put, del } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { poster } from "../img";
import { mediaPath, publicListPath, type MediaType } from "../paths";
import { fmtAgo } from "../format";
import { Wordmark, SmpteBars, ErrorNote, Slate, SiteFooter } from "../components/ui";
import { ShareButton } from "../components/share";
import { ProfileSkeleton } from "../components/skeleton";
import { IconList, IconCheck, IconPlus, IconEye } from "../components/icons";
import { StatsGrid, type WatchStats } from "./profile";
import { fmtDateTime } from "../format";
import { ACHIEVEMENTS_BY_ID } from "../../shared/achievements";

interface ProfileComment {
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

interface PublicProfile {
  username: string;
  stats: WatchStats;
  lists: { id: number; name: string; count: number; posters: string[] }[];
  achievements: string[];
  comments: ProfileComment[];
}

// Unlocked achievements only — a public profile is a brag wall, not a
// checklist of what the person hasn't done.
function PublicAchievements({ ids }: { ids: string[] }) {
  const unlocked = ids.map((id) => ACHIEVEMENTS_BY_ID.get(id)).filter((a) => a != null);
  if (!unlocked.length) return null;
  return (
    <>
      <h2 className="section-title">Achievements</h2>
      <div className="ach-grid">
        {unlocked.map((a) => (
          <div key={a.id} className="ach is-unlocked" title={a.desc}>
            <span className="ach-emoji" aria-hidden="true">
              {a.emoji}
            </span>
            <span className="ach-title">{a.title}</span>
            <span className="ach-desc">{a.desc}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// Recent comment activity (issue #16): what shows this user is talking
// about, each row linking into the thread's page. Anonymous visitors see
// metadata only (no bodies — the server withholds them).
function ProfileComments({ comments }: { comments: ProfileComment[] }) {
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

type Relation = "none" | "following" | "self";

// Follow/unfollow affordance, shown only to signed-in visitors on someone
// else's profile. Social actions never queue offline — failures show inline.
// Renders as a fragment inside the page's .public-actions row so it sits
// beside the share button.
function FollowActions({ username }: { username: string }) {
  const confirm = useConfirm();
  const [relation, setRelation] = useState<Relation | null>(null);
  const [followsYou, setFollowsYou] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRelation(null);
    api<{ user: { username: string; relation: Relation; followsYou: boolean } | null }>(
      `/social/search?q=${encodeURIComponent(username)}`
    )
      .then((d) => {
        if (!live) return;
        setRelation(d.user?.relation ?? null);
        setFollowsYou(d.user?.followsYou ?? false);
      })
      .catch(() => {}); // no button is fine (e.g. offline)
    return () => {
      live = false;
    };
  }, [username]);

  if (!relation || relation === "self") return null;

  const act = (fn: () => Promise<unknown>, next: Relation) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setRelation(next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {relation === "none" && (
        <button className="btn" disabled={busy} onClick={act(() => post("/social/follow", { username }), "following")}>
          <IconPlus size={15} /> {followsYou ? "Follow back" : "Follow"}
        </button>
      )}
      {relation === "following" && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          title={`You follow ${username}. Click to unfollow`}
          onClick={async () => {
            const yes = await confirm({
              title: `Unfollow ${username}?`,
              message: "Their activity will stop showing in your feed. They won't be notified.",
              confirmLabel: "Unfollow",
              danger: true,
            });
            if (yes) await act(() => del(`/social/follow/${encodeURIComponent(username)}`), "none")();
          }}
        >
          <IconCheck size={14} /> Following
        </button>
      )}
      {followsYou && <span className="friend-note">Follows you</span>}
      {error && <ErrorNote message={error} />}
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
function AdminTools({ username, tz }: { username: string; tz: string }) {
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

export function PublicProfilePage() {
  const { username } = useParams();
  const { user } = useAuth();
  const { data, loading, error } = useApi<PublicProfile>(`/public/profile/${encodeURIComponent(username!)}`);

  return (
    <div className="public-page">
      <header className="header">
        <Link to="/" className="header-brand" aria-label="Show Us TV, home">
          <Wordmark />
        </Link>
      </header>
      <main className="main">
        {loading ? (
          <ProfileSkeleton />
        ) : error || !data ? (
          <div className="empty">
            <SmpteBars />
            <h3>Nothing to see here</h3>
            <p>This profile is private or doesn&rsquo;t exist.</p>
          </div>
        ) : (
          <>
            <h1 className="page-title">{data.username}</h1>
            <p className="public-byline">Watching TV on Show Us TV</p>
            {/* This page only renders for public profiles (the server 404s
                private ones), so the share affordance is always safe here. */}
            <div className="public-actions">
              <ShareButton
                title={`${data.username} on Show Us TV`}
                text={`See what ${data.username} has been watching on Show Us TV.`}
                path={`/u/${data.username}`}
              />
              {user && <FollowActions username={data.username} />}
            </div>
            {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}
            <StatsGrid stats={data.stats} />
            <PublicAchievements ids={data.achievements} />
            <ProfileComments comments={data.comments} />
            {data.lists.length > 0 && (
              <>
                <h2 className="section-title">Lists</h2>
                <div className="lists-grid">
                  {data.lists.map((l) => (
                    <Link key={l.id} to={publicListPath(username!, l.id, l.name)} className="list-card">
                      <div className="list-collage">
                        {l.posters.length ? (
                          l.posters.map((p, i) => <img key={i} src={poster(p, "w154")!} alt="" loading="lazy" />)
                        ) : (
                          <IconList size={28} />
                        )}
                      </div>
                      <span className="list-name">{l.name}</span>
                      <span className="mono list-count">
                        {l.count} {l.count === 1 ? "title" : "titles"}
                      </span>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
