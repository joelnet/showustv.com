// Dedicated achievements pages (issue #201). The profile pages used to
// render the whole grid inline, which crowded everything below it — they now
// show a compact "Achievements (18/31)" link and the grid lives here.
//
// Two flavors share this layout, both living at /u/:username/achievements
// (the old /profile/achievements redirects there, issue #220 — app.tsx picks
// which one renders):
//   Your own page — when the name is yours. Shows the full catalog as a
//     checklist: earned entries lit (hover for the unlock date), locked ones
//     dimmed with the goal as their hint — so the (18/31) count answers its
//     own "which am I missing?" question.
//   Anyone else's page — signed in or out. Unlocked only, matching the
//     public profile: a brag wall, not a checklist of what the person
//     hasn't done.
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi, dropCached } from "../hooks";
import { useAuth } from "../app";
import { fmtDateTime } from "../format";
import { SmpteBars, Empty, ErrorNote } from "../components/ui";
import { Skeleton } from "../components/skeleton";
import { IconLock } from "../components/icons";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, type Achievement } from "../../shared/achievements";

function Coin({ a, unlocked, title }: { a: Achievement; unlocked: boolean; title: string }) {
  return (
    <div className={`ach${unlocked ? " is-unlocked" : ""}`} title={title}>
      <span className="ach-emoji" aria-hidden="true">
        {a.emoji}
      </span>
      <span className="ach-title">{a.title}</span>
      <span className="ach-desc">{a.desc}</span>
    </div>
  );
}

function PageTitle({ earned }: { earned: number }) {
  return (
    <h1 className="page-title">
      Achievements{" "}
      <span className="mono ach-count">
        ({earned}/{ACHIEVEMENTS.length})
      </span>
    </h1>
  );
}

function AchPageSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="skel-page-title" />
      <div className="ach-grid">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} style={{ height: 128, borderRadius: 12 }} />
        ))}
      </div>
    </div>
  );
}

// The /profile payload — only the fields this page reads. Fetching the same
// path as the profile page shares its in-memory cache entry (issue #154), so
// following the profile's link paints instantly.
interface OwnProfile {
  achievements: { id: string; unlockedAt: string }[];
}

export function MyAchievementsPage() {
  const { user } = useAuth();
  const { data, loading, error } = useApi<OwnProfile>("/profile");
  if (loading) return <AchPageSkeleton />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const unlocked = new Map(data.achievements.map((a) => [a.id, a.unlockedAt]));
  return (
    <>
      <Link to={user ? `/u/${user.username}` : "/profile"} className="crumb">
        ‹ Profile
      </Link>
      <PageTitle earned={data.achievements.length} />
      <div className="ach-grid">
        {ACHIEVEMENTS.map((a) => {
          const at = unlocked.get(a.id);
          return (
            <Coin
              key={a.id}
              a={a}
              unlocked={unlocked.has(a.id)}
              title={at && user ? `Unlocked ${fmtDateTime(at, user.tz)}` : a.desc}
            />
          );
        })}
      </div>
    </>
  );
}

// The /public/profile payload — the server decides what this viewer may see
// (issues #158/#184): the full profile, a private teaser (no `stats`), or a
// 404. Same endpoint as the public profile page, so the cache entry is
// shared and the click over from there paints instantly.
interface PublicProfilePayload {
  username: string;
  private?: boolean;
  stats?: unknown; // presence marks a full payload — the discriminant
  achievements?: string[];
}

export function PublicAchievementsPage() {
  const { username } = useParams();
  const path = `/public/profile/${encodeURIComponent(username!)}`;
  const { data, loading, error } = useApi<PublicProfilePayload>(path);

  // Same cache hygiene as the profile page: a private profile served in full
  // is no-store on the wire (issues #158/#184) — drop the in-memory copy too,
  // so revoked access can't warm-paint stale private data here later.
  useEffect(() => {
    if (data?.private && data.stats) dropCached(path);
  }, [data, path]);

  if (loading) return <AchPageSkeleton />;
  if (error || !data) {
    return (
      <div className="empty">
        <SmpteBars />
        <h3>Nothing to see here</h3>
        <p>This profile doesn&rsquo;t exist.</p>
      </div>
    );
  }

  const crumb = (
    <Link to={`/u/${data.username}`} className="crumb">
      ‹ {data.username}
    </Link>
  );

  if (!data.stats) {
    // Private teaser: this viewer doesn't get the profile, so no counts
    // either — just the same lock note the profile page shows.
    return (
      <>
        {crumb}
        <h1 className="page-title">Achievements</h1>
        <div className="empty">
          <IconLock size={26} />
          <h3>This profile is private</h3>
          <p>Only {data.username} can see what&rsquo;s on it.</p>
        </div>
      </>
    );
  }

  const earned = (data.achievements ?? []).map((id) => ACHIEVEMENTS_BY_ID.get(id)).filter((a) => a != null);
  return (
    <>
      {crumb}
      <PageTitle earned={earned.length} />
      {earned.length ? (
        <div className="ach-grid">
          {earned.map((a) => (
            <Coin key={a.id} a={a} unlocked title={a.desc} />
          ))}
        </div>
      ) : (
        <Empty title="No achievements yet" hint={`${data.username} hasn't earned any so far.`} />
      )}
    </>
  );
}
