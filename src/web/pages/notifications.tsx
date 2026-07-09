// Notifications page (issue #129): everything behind the header bell, newest
// first. Landing here marks the lot read (the badge clears), but rows that
// were unread when the page loaded keep their highlight for this visit so
// what's new is still visible.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api";
import { useAuth } from "../app";
import { refreshUnread } from "../notifications";
import { poster } from "../img";
import { fmtAgo, fmtDateTime, epCode } from "../format";
import { mediaPath } from "../paths";
import { Empty, ErrorNote } from "../components/ui";
import { RowListSkeleton } from "../components/skeleton";

interface NotificationItem {
  id: number;
  type: string;
  actor: string | null; // null when the account has since been deleted
  targetType: "show" | "movie" | null;
  targetId: number | null;
  title: string | null;
  poster: string | null;
  // Episode watches carry the specific episode (null for movies, old rows, or
  // a since-deleted episode — the render falls back to show-only text).
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  read: boolean;
  createdAt: string;
}

// The verb-and-target phrase after the actor's name. 'follow_watch' is the
// only type today; a new type would branch here. The target links to its
// show/movie page (with its title as the anchor), and an episode watch names
// the episode inline: "watched S02·E05 · Waiting of Dexter". Missing episode
// info (movies, pre-migration rows, or a since-deleted episode) degrades to
// "watched an episode of Dexter" / "watched Inception".
function NotificationBody({ n }: { n: NotificationItem }) {
  const targetLink =
    n.targetType && n.targetId != null ? (
      <Link to={mediaPath(n.targetType, n.targetId, n.title)}>{n.title ?? `a ${n.targetType}`}</Link>
    ) : (
      <span>{n.title ?? "something"}</span>
    );

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

export function NotificationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

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
      {!items.length ? (
        <Empty
          title="No notifications yet"
          hint="When someone you follow watches a show or movie, you'll hear about it here."
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
