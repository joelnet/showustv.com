// Notifications page (issue #129): everything behind the header bell, newest
// first. Landing here marks the lot read (the badge clears), but rows that
// were unread when the page loaded keep their highlight for this visit so
// what's new is still visible.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import { useAuth } from "../app";
import { useApi } from "../hooks";
import { pushSupported, refreshUnread } from "../notifications";
import { poster } from "../img";
import { fmtAgo, fmtDateTime, epCode } from "../format";
import { Empty, ErrorNote } from "../components/ui";
import { IconPlus } from "../components/icons";
import { PushToggle } from "../components/push-toggle";
import { mediaPath } from "../paths";
import { RowListSkeleton } from "../components/skeleton";

interface NotificationItem {
  id: number;
  type: string;
  actor: string | null; // null when the account has since been deleted
  targetType: "show" | "movie" | null;
  targetId: number | null;
  title: string | null;
  poster: string | null;
  // Episode rows carry the specific episode (null for movies, old rows, or
  // a since-deleted episode — the render falls back to show-only text).
  episodeId: number | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  // Follow rows (issue #273) only: whether I follow the actor right now,
  // computed by the server at read time. Null for every other type.
  youFollowActor: boolean | null;
  read: boolean;
  createdAt: string;
}

// The verb-and-target phrase after the actor's name, branched per type:
// 'follow_watch' (issue #129), 'follow_comment' (issue #141),
// 'tracked_comment' (issue #236 — same phrase; only the reason you got it
// differs) and 'follow_favorite' (issue #266). The target links to its
// show/movie page (with its title as the anchor), and an episode row names
// the episode inline: "watched S02·E05 · Waiting of Dexter". An episode
// comment links the episode itself — that page is where the thread lives.
// Missing episode info (movies, pre-migration rows, or a since-deleted
// episode) degrades to "watched an episode of Dexter" / "commented on
// Dexter" / "watched Inception".
function NotificationBody({ n }: { n: NotificationItem }) {
  // Follow rows (issue #273) have no media target — the actor IS the story,
  // and their name (rendered by the caller) already links their profile. The
  // wording was fixed at creation time: 'follow_back' means the actor's
  // follow reciprocated one the recipient already had.
  if (n.type === "follow" || n.type === "follow_back") {
    return <>{n.type === "follow_back" ? "followed you back" : "followed you"}</>;
  }

  // Admin test rows (issue #275): the admin is their own actor, so this reads
  // "<username> sent a test notification". No target — nothing to link.
  if (n.type === "test") {
    return <>sent a test notification</>;
  }

  const targetLink =
    n.targetType && n.targetId != null ? (
      <Link to={mediaPath(n.targetType, n.targetId, n.title)}>{n.title ?? `a ${n.targetType}`}</Link>
    ) : (
      <span>{n.title ?? "something"}</span>
    );

  if (n.type === "follow_favorite") {
    return <>favorited {targetLink}</>;
  }

  if (n.type === "follow_comment" || n.type === "tracked_comment") {
    if (n.targetType === "show" && n.episodeId != null && n.season != null && n.number != null) {
      return (
        <>
          commented on{" "}
          <Link className="notif-ep" to={mediaPath("episode", n.episodeId, n.episodeTitle)}>
            {epCode(n.season, n.number)}
            {n.episodeTitle ? ` · ${n.episodeTitle}` : ""}
          </Link>{" "}
          of {targetLink}
        </>
      );
    }
    return <>commented on {targetLink}</>;
  }

  if (n.targetType === "show" && n.season != null && n.number != null) {
    return (
      <>
        watched{" "}
        <span className="notif-ep">
          {epCode(n.season, n.number)}
          {n.episodeTitle ? ` · ${n.episodeTitle}` : ""}
        </span>{" "}
        of {targetLink}
      </>
    );
  }
  if (n.targetType === "show") {
    return <>watched an episode of {targetLink}</>;
  }
  return <>watched {targetLink}</>;
}

// The follow-back affordance (issue #273), shown on a follow row only while
// the recipient doesn't already follow the actor. The server computes that
// live at read time, so a follow made anywhere (their profile, the following
// page) means the button simply doesn't render on the next load — this
// visit only needs to cover its own clicks. `done` comes from the PAGE (a
// per-actor set), not local state: two historical rows from the same actor
// both settle to a quiet "Following" the moment either button is clicked.
// Same endpoint and idempotence as the following page's Follow back button.
function FollowBackButton({ username, done, onDone }: { username: string; done: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (done) return <span className="mono notif-when">Following</span>;
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await post("/social/follow", { username });
          onDone();
        } catch {
          // failed — leave the button for a retry
        } finally {
          setBusy(false);
        }
      }}
    >
      <IconPlus size={14} /> Follow back
    </button>
  );
}

// Extra path to turn on push (issue #237): people live on this page (it's
// where the bell lands) long before they ever open settings, so surface the
// same per-device opt-in here when this browser could receive pushes but
// isn't subscribed. PushToggle's `discover` mode keeps it invisible unless
// push is actually off, so subscribed devices see nothing at all.
function PushPrompt() {
  // The prefs fetch only carries the VAPID key here — skip it entirely when
  // this browser can't do push (then nothing could ever render anyway).
  const { data } = useApi<{ pushPublicKey: string | null }>(pushSupported() ? "/notifications/prefs" : null);
  if (!data?.pushPublicKey) return null;
  return <PushToggle publicKey={data.pushPublicKey} discover className="notif-push" />;
}

export function NotificationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Actors followed back DURING this visit — keyed by username so every row
  // from the same actor settles together, not just the one that was clicked.
  const [followedBack, setFollowedBack] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async (before: number | null) => {
    const q = before ? `?before=${before}` : "";
    return api<{ items: NotificationItem[]; nextCursor: number | null }>(`/notifications${q}`);
  }, []);

  useEffect(() => {
    let live = true;
    load(null)
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setCursor(d.nextCursor);
        // Viewing the page clears the badge — but only through the newest id
        // actually displayed, so a notification that lands mid-request stays
        // unread. The items keep the read state they were fetched with, so
        // fresh ones stay highlighted this visit. refreshUnread() (not a bare
        // setUnread(0)) keeps the badge honest about any such late arrival.
        const markThrough = d.items.some((n) => !n.read) ? d.items[0].id : null;
        const settle = markThrough ? post("/notifications/read-all", { throughId: markThrough }) : Promise.resolve();
        void settle.catch(() => {}).then(() => refreshUnread());
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [load]);

  if (error) return <ErrorNote message={error} />;
  // The title is static — render it for real during the load so only the
  // feed rows are skeletal.
  if (!items)
    return (
      <div>
        <h1 className="page-title">Notifications</h1>
        <RowListSkeleton count={6} />
      </div>
    );

  const tz = user!.tz;
  return (
    <div>
      <h1 className="page-title">Notifications</h1>
      <PushPrompt />
      {!items.length ? (
        <Empty
          title="No notifications yet"
          hint="When someone follows you, comments on a show or movie you track, or someone you follow watches, favorites, or comments, you'll hear about it here."
        />
      ) : (
        <>
          <ul className="notif-list">
            {items.map((n) => (
              <li key={n.id} className={n.read ? undefined : "is-unread"}>
                {n.poster && <img className="notif-poster" src={poster(n.poster, "w154")!} alt="" loading="lazy" />}
                <span className="notif-text">
                  {n.actor ? (
                    <Link to={`/u/${n.actor}`} className="notif-user">
                      {n.actor}
                    </Link>
                  ) : (
                    <span className="notif-user">Someone</span>
                  )}{" "}
                  <NotificationBody n={n} />
                </span>
                {n.actor != null && n.youFollowActor === false && (
                  <FollowBackButton
                    username={n.actor}
                    done={followedBack.has(n.actor)}
                    onDone={() => setFollowedBack((cur) => new Set(cur).add(n.actor!))}
                  />
                )}
                <span className="mono notif-when" title={fmtDateTime(n.createdAt, tz)}>
                  {fmtAgo(n.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          {cursor != null && (
            <button
              className="link-btn"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                try {
                  const d = await load(cursor);
                  setItems((cur) => [...(cur ?? []), ...d.items]);
                  setCursor(d.nextCursor);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setLoadingMore(false);
                }
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
