// Public, read-only profile at /u/:username. A public profile shows watch
// stats plus the lists the owner pinned (public lists only). A private
// profile shows an Instagram-style teaser instead: the username and a "this
// profile is private" note. A mutual follow still
// sees the full page of a private profile — the server decides, this page
// just renders what it's sent. The one viewer who never lands here is the
// profile's own owner: /u/<their name> is where their own profile lives now,
// so the router sends them to the owner view (profile.tsx),
// which reuses the section components defined there.
// Signed-in visitors also get a follow/unfollow affordance here.
// Renders inside the standard site chrome like every other page:
// the app Shell when signed in, PublicShell when signed out — no
// bespoke header here.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, post, put, del } from "../api";
import { useApi, useDocumentTitle, dropCached } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { useToast } from "../components/toast";
import { poster } from "../img";
import { publicListPath } from "../paths";
import { SmpteBars, ErrorNote } from "../components/ui";
import { ShareButton } from "../components/share";
import { ProfileSkeleton } from "../components/skeleton";
import { IconList, IconCheck, IconPlus, IconLock, IconChevron, IconBell, IconBellOff } from "../components/icons";
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
  // True when a private profile is served in full — to a mutual follow.
  // Every other viewer of a private profile gets the teaser
  // instead.
  private?: boolean;
  stats: WatchStats;
  lists: { id: number; name: string; count: number; posters: string[] }[];
  achievements: string[];
  comments: ProfileComment[];
  history?: ProfileHistoryData; // optional: tolerates older cached payloads
}

// What a private profile serves to everyone but its owner: the
// username and the flag, never the content. `stats` is the discriminant.
interface PrivateTeaser {
  username: string;
  private: true;
  stats?: undefined;
}

type PublicProfile = FullProfile | PrivateTeaser;

// Compact link to the dedicated achievements page — the grid
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
type NotifyLevel = "all" | "some" | "none";

// The YouTube-style per-follow alert levels (#18), in menu order. The hint
// spells out what each one means so "Some" isn't a mystery word.
const NOTIFY_LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every alert, even repeats" },
  { value: "some", label: "Some", hint: "Highlights — at most daily per title" },
  { value: "none", label: "None", hint: "Never notify me" },
];

// Bell control on a followed user's profile (#18) — this is the single
// follow control once you follow someone, replacing the old
// Following/Mutuals buttons. The bell (muted glyph when the level is None)
// sits immediately right of the username and opens a menu with the three
// alert levels — the current one checked — plus Unfollow, behind the same
// confirm dialog as before. The menu closes on outside click, Escape
// (refocusing the trigger), selection, or focus leaving it; ArrowUp/Down
// cycle the items and the current level takes focus on open.
function BellMenu({
  username,
  mutual,
  busy,
  level,
  onLevel,
  onUnfollow,
}: {
  username: string;
  mutual: boolean;
  busy: boolean;
  level: NotifyLevel;
  onLevel: (next: NotifyLevel) => void;
  onUnfollow: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Land keyboard users on the current level when the menu opens.
  useEffect(() => {
    if (open) itemRefs.current[NOTIFY_LEVELS.findIndex((l) => l.value === level)]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Arrow keys walk the menu, wrapping at the ends — the expected
  // role="menu" keyboard model.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const label = NOTIFY_LEVELS.find((l) => l.value === level)?.label ?? "Some";
  const state = `Notifications: ${label}${mutual ? " · You follow each other" : ""}`;

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
        className={`icon-btn bell-btn${level === "none" ? " is-muted" : ""}`}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Following ${username} — ${state}`}
        title={state}
        onClick={() => setOpen((o) => !o)}
      >
        {level === "none" ? <IconBellOff size={19} /> : <IconBell size={19} />}
      </button>
      {open && (
        <div
          className="menu-pop menu-pop--bell"
          role="menu"
          aria-label={`Notifications from ${username}`}
          onKeyDown={onMenuKey}
        >
          {NOTIFY_LEVELS.map((opt, i) => (
            <button
              key={opt.value}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={level === opt.value}
              className={`menu-item menu-item--radio${level === opt.value ? " is-checked" : ""}`}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                if (opt.value !== level) onLevel(opt.value);
              }}
            >
              <span className="menu-radio-mark" aria-hidden="true">
                {level === opt.value && <IconCheck size={14} />}
              </span>
              <span className="menu-radio-text">
                {opt.label}
                <span className="menu-hint">{opt.hint}</span>
              </span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            ref={(el) => {
              itemRefs.current[NOTIFY_LEVELS.length] = el;
            }}
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

// Follow affordance, shown only to signed-in visitors on someone else's
// profile, rendered inside the .profile-head row right of the username (#18).
// Not following → a [Follow] button; following → the BellMenu above (alert
// level + Unfollow in one control). Social actions never queue offline —
// failures show inline (level changes toast instead: the bell repaints
// optimistically). `onChange` fires after a successful follow or
// unfollow — on a private profile the relationship decides what the server
// serves, so the page refetches: following back reveals a
// mutual's full profile, and unfollowing drops the viewer back to the teaser
// instead of leaving revoked-access content on screen.
function FollowActions({ username, onChange }: { username: string; onChange?: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [relation, setRelation] = useState<Relation | null>(null);
  const [followsYou, setFollowsYou] = useState(false);
  const [level, setLevel] = useState<NotifyLevel>("some");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRelation(null);
    api<{
      user: { username: string; relation: Relation; followsYou: boolean; notifyLevel: NotifyLevel | null } | null;
    }>(`/social/search?q=${encodeURIComponent(username)}`)
      .then((d) => {
        if (!live) return;
        setRelation(d.user?.relation ?? null);
        setFollowsYou(d.user?.followsYou ?? false);
        setLevel(d.user?.notifyLevel ?? "some");
      })
      .catch(() => {}); // no button is fine (e.g. offline)
    return () => {
      live = false;
    };
  }, [username]);

  if (!relation || relation === "self") return null;

  const follow = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await post("/social/follow", { username });
      setRelation("following");
      // A fresh follow starts at Some; an idempotent re-follow echoes the
      // level the user had already picked.
      setLevel((d?.notifyLevel as NotifyLevel) ?? "some");
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
    if (!yes) return;
    setBusy(true);
    setError(null);
    try {
      await del(`/social/follow/${encodeURIComponent(username)}`);
      setRelation("none");
      setLevel("some");
      onChange?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Optimistic level change: the bell flips immediately, a toast confirms,
  // and a failed PUT flips it back with an error toast.
  const changeLevel = async (next: NotifyLevel) => {
    const prev = level;
    setLevel(next);
    try {
      await put(`/social/follow/${encodeURIComponent(username)}/notify`, { level: next });
      toast(
        next === "all"
          ? `You'll get every alert from ${username}`
          : next === "some"
            ? `You'll get occasional alerts from ${username}`
            : `Alerts from ${username} are muted`
      );
    } catch (e: any) {
      setLevel(prev);
      toast(e.message || "Couldn't update notifications", "error");
    }
  };

  return (
    <>
      {relation === "none" ? (
        <button className="btn" disabled={busy} onClick={follow}>
          <IconPlus size={15} /> {followsYou ? "Follow back" : "Follow"}
        </button>
      ) : (
        <BellMenu
          username={username}
          mutual={followsYou}
          busy={busy}
          level={level}
          onLevel={changeLevel}
          onUnfollow={unfollow}
        />
      )}
      {followsYou && relation === "none" && <span className="friend-note">Follows you</span>}
      {error && <ErrorNote message={error} />}
    </>
  );
}

export function PublicProfilePage() {
  const { username } = useParams();
  const { user } = useAuth();
  const path = `/public/profile/${encodeURIComponent(username!)}`;
  const { data, loading, error, reload } = useApi<PublicProfile>(path);

  // Keep the tab title the Worker baked in for public profiles
  // once the SPA takes over — DocumentTitleSync only spares this route from
  // the default reset; the canonical DB casing arrives with the data.
  useDocumentTitle(data && `@${data.username}`);

  // A private profile served in full is no-store on the wire
  // — the service worker honors that, and this mirrors it in the
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
        // Private profile teaser: the server sent the username
        // and nothing else. Signed-in visitors keep the follow affordance —
        // following works regardless of profile visibility, and following
        // back someone who already follows you makes the pair mutual, so
        // the refetch swaps the teaser for the full profile.
        <>
          <div className="profile-head">
            <h1 className="page-title">{data.username}</h1>
            {user && <FollowActions username={data.username} onChange={reload} />}
          </div>
          {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}
          <div className="empty">
            <IconLock size={26} />
            <h3>This profile is private</h3>
            <p>Only {data.username} can see what&rsquo;s on it.</p>
          </div>
        </>
      ) : (
        <>
          {/* The follow control sits immediately right of the name (#18):
              a [Follow] button, or the bell menu once following. Share stays
              a bare glyph in the same row, matching the owner's view of the
              page. Share is withheld on a private profile served in full to
              a mutual follow — other visitors would only get the teaser —
              with no privacy note either: this viewer already has access,
              so the message is noise. */}
          <div className="profile-head">
            <h1 className="page-title">{data.username}</h1>
            {user && <FollowActions username={data.username} onChange={reload} />}
            {!data.private && (
              <ShareButton
                variant="icon"
                title={`${data.username} on Show Us TV`}
                text={`See what ${data.username} has been watching on Show Us TV.`}
                path={`/u/${data.username}`}
              />
            )}
          </div>
          {user?.isAdmin && <AdminTools username={data.username} tz={user.tz} />}
          <StatsGrid stats={data.stats} />
          {/* Watch history rows, above Achievements — only ever
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
