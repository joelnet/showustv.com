// Following (issue #39): follow people by username, see who follows you, and
// read the activity feed of the people you follow. Instagram-style asymmetric
// follows — no accept step, and following isn't mutual. Pairs that DO follow
// each other surface in a Mutuals section up top (issue #130).
//
// Social mutations are deliberately NOT offline-queueable (api.ts only queues
// watch/favorite ops) — when the network is gone they fail fast and the error
// is shown inline instead of pretending to succeed.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post, del } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { poster } from "../img";
import { fmtDateTime } from "../format";
import { Empty, ErrorNote } from "../components/ui";
import { FollowingSkeleton, RowListSkeleton } from "../components/skeleton";
import { mediaPath } from "../paths";
import { IconPlus, IconTrash } from "../components/icons";

interface FollowsData {
  mutuals: { username: string; since: string }[];
  following: { username: string; since: string }[];
  followers: { username: string; since: string; youFollow: boolean }[];
}

export interface ActivityItem {
  type: "watched" | "followed" | "rated";
  username: string;
  target_type: "show" | "movie";
  target_id: number;
  title: string;
  poster: string | null;
  count: number;
  score: number | null;
  ts: string;
  k: string; // server-side unique row key (doubles as the pagination tie-break)
}

// Follow dates render date-only in the viewer's profile timezone.
function fmtDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });
}

function activityPhrase(a: ActivityItem): string {
  if (a.type === "followed") return "started following";
  if (a.type === "rated") return `rated ${a.score}/10:`;
  if (a.target_type === "show") return a.count === 1 ? "watched an episode of" : `watched ${a.count} episodes of`;
  return "watched";
}

export function ActivityFeed() {
  const { user } = useAuth();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before: string | null) => {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    return api<{ items: ActivityItem[]; nextCursor: string | null }>(`/social/activity${q}`);
  }, []);

  useEffect(() => {
    let live = true;
    load(null)
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setCursor(d.nextCursor);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!items) return <RowListSkeleton count={5} />;
  if (!items.length)
    return <Empty title="Nothing here yet" hint="When someone you follow watches, follows, or rates something, it shows up here." />;

  const tz = user!.tz;
  return (
    <>
      <ul className="activity-feed">
        {items.map((a) => (
          <li key={`${a.k}:${a.ts}`}>
            {a.poster && <img className="activity-poster" src={poster(a.poster, "w154")!} alt="" loading="lazy" />}
            <span className="activity-text">
              <Link to={`/u/${a.username}`} className="activity-user">
                {a.username}
              </Link>{" "}
              {activityPhrase(a)}{" "}
              <Link to={mediaPath(a.target_type === "show" ? "show" : "movie", a.target_id, a.title)}>{a.title}</Link>
            </span>
            <span className="mono activity-when">{fmtDateTime(a.ts, tz)}</span>
          </li>
        ))}
      </ul>
      {cursor && (
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
  );
}

export function FollowingPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<FollowsData>("/social/follows");
  const [username, setUsername] = useState("");
  const [note, setNote] = useState<{ text: string; isError: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      reload();
    } catch (e: any) {
      setNote({ text: e.message, isError: true });
    } finally {
      setBusy(false);
    }
  };

  async function follow(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setNote(null);
    try {
      await post("/social/follow", { username: name });
      setUsername("");
      setNote({ text: `You're now following ${name}`, isError: false });
      reload();
    } catch (err: any) {
      setNote({ text: err.message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  // The title is static — render it for real during the load so only the
  // page body is skeletal.
  if (loading)
    return (
      <div>
        <h1 className="page-title">Following</h1>
        <FollowingSkeleton />
      </div>
    );
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  // Tolerate an offline-cached /social/follows body from before the mutuals
  // field existed (the SW replays the last good copy when the network is gone).
  const mutuals = data.mutuals ?? [];

  const tz = user!.tz;
  return (
    <div>
      <h1 className="page-title">Following</h1>

      <form className="friend-add" onSubmit={follow}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Follow someone by username"
          aria-label="Follow someone by username"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="btn" disabled={busy || !username.trim()}>
          <IconPlus size={15} /> Follow
        </button>
      </form>
      {note && (note.isError ? <ErrorNote message={note.text} /> : <p className="friend-note">{note.text} ✓</p>)}

      {/* Mutuals (issue #130): people you follow who follow you back. The
          section hides entirely when there are none rather than adding a third
          empty block to a fresh account. Rows are plain links; unfollow lives
          in the Following list below. */}
      {mutuals.length > 0 && (
        <>
          <h2 className="section-title">Mutuals · {mutuals.length}</h2>
          <ul className="list-items">
            {mutuals.map((f) => (
              <li key={f.username}>
                <Link to={`/u/${f.username}`} className="profile-list-link">
                  <span className="list-name">{f.username}</span>
                  <span className="mono list-count">mutuals since {fmtDate(f.since, tz)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="section-title">Following{data.following.length > 0 && ` · ${data.following.length}`}</h2>
      {!data.following.length ? (
        <Empty title="Not following anyone yet" hint="Follow someone by username to see what they're watching." />
      ) : (
        <ul className="list-items">
          {data.following.map((f) => (
            <li key={f.username}>
              <Link to={`/u/${f.username}`} className="profile-list-link">
                <span className="list-name">{f.username}</span>
                <span className="mono list-count">following since {fmtDate(f.since, tz)}</span>
              </Link>
              <div className="list-item-actions">
                <button
                  className="btn btn-ghost btn-danger"
                  disabled={busy}
                  aria-label={`Unfollow ${f.username}`}
                  title={`Unfollow ${f.username}`}
                  onClick={async () => {
                    const yes = await confirm({
                      title: `Unfollow ${f.username}?`,
                      message: "Their activity will stop showing in your feed. They won't be notified.",
                      confirmLabel: "Unfollow",
                      danger: true,
                    });
                    if (yes) await act(() => del(`/social/follow/${encodeURIComponent(f.username)}`))();
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Followers{data.followers.length > 0 && ` · ${data.followers.length}`}</h2>
      {!data.followers.length ? (
        <Empty title="No followers yet" hint="When someone follows you, they'll show up here." />
      ) : (
        <ul className="list-items">
          {data.followers.map((f) => (
            <li key={f.username}>
              <Link to={`/u/${f.username}`} className="profile-list-link">
                <span className="list-name">{f.username}</span>
                <span className="mono list-count">
                  {f.youFollow ? "you follow each other" : `followed you ${fmtDate(f.since, tz)}`}
                </span>
              </Link>
              {!f.youFollow && (
                <div className="list-item-actions">
                  <button className="btn" disabled={busy} onClick={act(() => post("/social/follow", { username: f.username }))}>
                    <IconPlus size={14} /> Follow back
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Activity</h2>
      <ActivityFeed />
    </div>
  );
}
