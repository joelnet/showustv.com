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
import { useEffect, useRef, useState } from "react";
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
import { IconList, IconCheck, IconPlus, IconLock, IconChevron, IconHandshake } from "../components/icons";
import {
  StatsGrid,
  ProfileHistory,
  ProfileComments,
  AdminTools,
  type WatchStats,
  type ProfileComment,
  type ProfileHistoryData,
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
  history?: ProfileHistoryData; // optional: tolerates cached pre-#245 payloads
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

// Mutual control on a mutual's profile (issue #255): a handshake "Mutuals"
// button that only shows its menu when clicked — one Unfollow item, behind
// the same confirm dialog as the plain "Following" button. Replaces the
// always-a-dropdown native select from issue #199. The menu closes on
// outside click, Escape (refocusing the trigger), or focus leaving it.
function MutualMenu({
  username,
  busy,
  onUnfollow,
}: {
  username: string;
  busy: boolean;
  onUnfollow: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Land keyboard users on the one action when the menu opens.
  useEffect(() => {
    if (open) itemRef.current?.focus();
  }, [open]);

  return (
    <div
      className="menu-wrap"
      ref={wrapRef}
      onBlur={(e) => {
        // Tabbing (or clicking) out of the control closes the menu.
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`You and ${username} follow each other`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconHandshake size={15} /> Mutuals
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label={`Mutual with ${username}`}>
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            className="menu-item menu-item--danger"
            onClick={async () => {
              setOpen(false);
              await onUnfollow();
              // A cancelled confirm leaves the control mounted — put focus
              // back on the trigger (no-op after a real unfollow unmounts it).
              triggerRef.current?.focus();
            }}
          >
            Unfollow
          </button>
        </div>
      )}
    </div>
  );
}

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

  // You follow each other — one "Mutuals" control replaces the "Following"
  // button + "Follows you" note pair (issue #199, redesigned in #255).
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
      {mutual && <MutualMenu username={username} busy={busy} onUnfollow={unfollow} />}
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
          {/* Watch history rows (issue #245), above Achievements — only ever
              present on a full profile payload (the teaser branch above never
              has it), so profile visibility is the one and only gate. The
              headings open this user's public library. */}
          {data.history && <ProfileHistory history={data.history} base={`/u/${data.username}/library`} />}
          <PublicAchievements username={data.username} ids={data.achievements} />
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
