// Public, read-only profile at /u/:username. A public profile shows watch
// stats plus the lists the owner pinned (public lists only). A private
// profile shows an Instagram-style teaser instead: the username and a "this
// profile is private" note (issue #158). A mutual follow (issue #184) still
// sees the full page of a private profile — the server decides, this page
// just renders what it's sent. The one viewer who never lands here is the
// profile's own owner: /u/<their name> is where their own profile lives now
// (issue #220), so the router sends them to the owner view (profile.tsx),
// which reuses the section components defined there.
// Signed-in visitors also get a follow/unfollow affordance here.
// Renders inside the standard site chrome like every other page (issue
// #200): the app Shell when signed in, PublicShell when signed out — no
// bespoke header here.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, post, del } from "../api";
import { useApi, useDocumentTitle, dropCached } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { poster } from "../img";
import { publicListPath } from "../paths";
import { SmpteBars, ErrorNote } from "../components/ui";
import { ShareButton } from "../components/share";
import { ProfileSkeleton } from "../components/skeleton";
import { IconList, IconCheck, IconPlus, IconLock, IconChevron } from "../components/icons";
import {
  StatsGrid,
  ProfileActivity,
  ProfileComments,
  AdminTools,
  type WatchStats,
  type ActivityItem,
  type ProfileComment,
} from "./profile";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID } from "../../shared/achievements";

interface FullProfile {
  username: string;
  // True when a private profile is served in full — to a mutual follow
  // (issue #184). Every other viewer of a private profile gets the teaser
  // instead.
  private?: boolean;
  stats: WatchStats;
  lists: { id: number; name: string; count: number; posters: string[] }[];
  achievements: string[];
  comments: ProfileComment[];
  activity?: ActivityItem[]; // optional: tolerates cached pre-#202 payloads
}

// What a private profile serves to everyone but its owner (issue #158): the
// username and the flag, never the content. `stats` is the discriminant.
interface PrivateTeaser {
  username: string;
  private: true;
  stats?: undefined;
}

type PublicProfile = FullProfile | PrivateTeaser;

// Compact link to the dedicated achievements page (issue #201) — the grid
// used to render here and crowded the page. The count is earned/total; the
// page itself still shows unlocked only (a public profile is a brag wall,
// not a checklist of what the person hasn't done), so zero earned hides the
// row entirely rather than advertising an empty page.
function PublicAchievements({ username, ids }: { username: string; ids: string[] }) {
  const earned = ids.filter((id) => ACHIEVEMENTS_BY_ID.has(id)).length;
  if (!earned) return null;
  return (
    <h2 className="section-title">
      <Link to={`/u/${username}/achievements`} className="ach-page-link">
        Achievements{" "}
        <span className="mono ach-count">
          ({earned}/{ACHIEVEMENTS.length})
        </span>
        <IconChevron size={11} />
      </Link>
    </h2>
  );
}

type Relation = "none" | "following" | "self";

// Follow/unfollow affordance, shown only to signed-in visitors on someone
// else's profile. Social actions never queue offline — failures show inline.
// Renders as a fragment inside the page's .public-actions row so it sits
// beside the share button. `onChange` fires after a successful follow or
// unfollow — on a private profile the relationship decides what the server
// serves (issue #184), so the page refetches: following back reveals a
// mutual's full profile, and unfollowing drops the viewer back to the teaser
// instead of leaving revoked-access content on screen.
function FollowActions({ username, onChange }: { username: string; onChange?: () => void }) {
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
      onChange?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const unfollow = async () => {
    const yes = await confirm({
      title: `Unfollow ${username}?`,
      message: "Their activity will stop showing in your feed. They won't be notified.",
      confirmLabel: "Unfollow",
      danger: true,
    });
    if (yes) await act(() => del(`/social/follow/${encodeURIComponent(username)}`), "none")();
  };

  // You follow each other — one "Mutual" control replaces the "Following"
  // button + "Follows you" note pair (issue #199).
  const mutual = relation === "following" && followsYou;

  return (
    <>
      {relation === "none" && (
        <button className="btn" disabled={busy} onClick={act(() => post("/social/follow", { username }), "following")}>
          <IconPlus size={15} /> {followsYou ? "Follow back" : "Follow"}
        </button>
      )}
      {relation === "following" && !mutual && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          title={`You follow ${username}. Click to unfollow`}
          onClick={unfollow}
        >
          <IconCheck size={14} /> Following
        </button>
      )}
      {mutual && (
        // Same native-select dropdown pattern as AddToList. The value stays
        // pinned to "" so a cancelled (or failed) unfollow snaps the label
        // back to "Mutual".
        <select
          className="mutual-select"
          aria-label={`Mutual: you and ${username} follow each other`}
          title={`You and ${username} follow each other`}
          disabled={busy}
          value=""
          onChange={async (e) => {
            if (e.target.value === "unfollow") await unfollow();
          }}
        >
          <option value="">Mutual</option>
          <option value="unfollow">Unfollow</option>
        </select>
      )}
      {followsYou && !mutual && <span className="friend-note">Follows you</span>}
      {error && <ErrorNote message={error} />}
    </>
  );
}

export function PublicProfilePage() {
  const { username } = useParams();
  const { user } = useAuth();
  const path = `/public/profile/${encodeURIComponent(username!)}`;
  const { data, loading, error, reload } = useApi<PublicProfile>(path);

  // Keep the tab title the Worker baked in for public profiles (issue #219)
  // once the SPA takes over — DocumentTitleSync only spares this route from
  // the default reset; the canonical DB casing arrives with the data.
  useDocumentTitle(data && `@${data.username}`);

  // A private profile served in full is no-store on the wire (issues
  // #158/#184) — the service worker honors that, and this mirrors it in the
  // in-memory page cache: drop the entry so navigating back after access is
  // revoked (unfollowed, or the owner unfollowed) cold-loads fresh instead
  // of warm-painting the old private payload.
  useEffect(() => {
    if (data?.stats && data.private) dropCached(path);
  }, [data, path]);

  return (
    <>
      {loading ? (
        <ProfileSkeleton />
      ) : error || !data ? (
        <div className="empty">
          <SmpteBars />
          <h3>Nothing to see here</h3>
          <p>This profile doesn&rsquo;t exist.</p>
        </div>
      ) : !data.stats ? (
        // Private profile teaser (issue #158): the server sent the username
        // and nothing else. Signed-in visitors keep the follow affordance —
        // following works regardless of profile visibility, and following
        // back someone who already follows you makes the pair mutual, so
        // the refetch swaps the teaser for the full profile (issue #184).
        <>
          <h1 className="page-title">{data.username}</h1>
          {user && (
            <div className="public-actions">
              <FollowActions username={data.username} onChange={reload} />
            </div>
          )}
          {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}
          <div className="empty">
            <IconLock size={26} />
            <h3>This profile is private</h3>
            <p>Only {data.username} can see what&rsquo;s on it.</p>
          </div>
        </>
      ) : (
        <>
          {/* Share sits as a bare glyph right of the name (issue #241),
              matching the owner's view of the same page. It's withheld on a
              private profile served in full to a mutual follow (issue #184)
              — other visitors would only get the teaser — with no privacy
              note either: this viewer already has access, so the message is
              noise (issue #198). Just the usual follow affordance below. */}
          <div className="profile-head">
            <h1 className="page-title">{data.username}</h1>
            {!data.private && (
              <ShareButton
                variant="icon"
                title={`${data.username} on Show Us TV`}
                text={`See what ${data.username} has been watching on Show Us TV.`}
                path={`/u/${data.username}`}
              />
            )}
          </div>
          {user && (
            <div className="public-actions">
              <FollowActions username={data.username} onChange={reload} />
            </div>
          )}
          {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}
          <StatsGrid stats={data.stats} />
          <PublicAchievements username={data.username} ids={data.achievements} />
          <ProfileActivity items={data.activity ?? []} />
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
    </>
  );
}
