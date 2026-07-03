// Friends (issue #3): add friends by username, answer requests, and see what
// friends have been watching (the activity feed lives here too).
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
import { Spinner, Empty, ErrorNote } from "../components/ui";
import { mediaPath } from "../paths";
import { IconCheck, IconPlus, IconTrash } from "../components/icons";

interface FriendsData {
  friends: { username: string; since: string }[];
  incoming: { username: string; at: string }[];
  outgoing: { username: string; at: string }[];
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

// Friendship dates render date-only in the viewer's profile timezone.
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
  if (!items) return <Spinner />;
  if (!items.length)
    return <Empty title="Nothing here yet" hint="When your friends watch, follow, or rate something, it shows up here." />;

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

export function FriendsPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useApi<FriendsData>("/social/friends");
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

  async function sendRequest(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await post("/social/requests", { username: name });
      setUsername("");
      setNote(
        res.status === "friends"
          ? { text: `You and ${name} are now friends`, isError: false }
          : { text: `Friend request sent to ${name}`, isError: false }
      );
      reload();
    } catch (err: any) {
      setNote({ text: err.message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const tz = user!.tz;
  return (
    <div>
      <h1 className="page-title">Friends</h1>

      <form className="friend-add" onSubmit={sendRequest}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Add a friend by username"
          aria-label="Add a friend by username"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="btn" disabled={busy || !username.trim()}>
          <IconPlus size={15} /> Add friend
        </button>
      </form>
      {note && (note.isError ? <ErrorNote message={note.text} /> : <p className="friend-note">{note.text} ✓</p>)}

      {data.incoming.length > 0 && (
        <>
          <h2 className="section-title">Friend requests</h2>
          <ul className="list-items">
            {data.incoming.map((r) => (
              <li key={r.username}>
                <Link to={`/u/${r.username}`} className="profile-list-link">
                  <span className="list-name">{r.username}</span>
                  <span className="mono list-count">asked {fmtDate(r.at, tz)}</span>
                </Link>
                <div className="list-item-actions">
                  <button className="btn" disabled={busy} onClick={act(() => post(`/social/requests/${encodeURIComponent(r.username)}/accept`))}>
                    <IconCheck size={14} /> Accept
                  </button>
                  <button className="btn btn-ghost" disabled={busy} onClick={act(() => del(`/social/requests/${encodeURIComponent(r.username)}`))}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {data.outgoing.length > 0 && (
        <>
          <h2 className="section-title">Sent requests</h2>
          <ul className="list-items">
            {data.outgoing.map((r) => (
              <li key={r.username}>
                <Link to={`/u/${r.username}`} className="profile-list-link">
                  <span className="list-name">{r.username}</span>
                  <span className="mono list-count">sent {fmtDate(r.at, tz)} · waiting for them to accept</span>
                </Link>
                <div className="list-item-actions">
                  <button className="btn btn-ghost" disabled={busy} onClick={act(() => del(`/social/requests/${encodeURIComponent(r.username)}`))}>
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="section-title">Your friends</h2>
      {!data.friends.length ? (
        <Empty title="No friends yet" hint="Add someone by username — they'll get a request to accept." />
      ) : (
        <ul className="list-items">
          {data.friends.map((f) => (
            <li key={f.username}>
              <Link to={`/u/${f.username}`} className="profile-list-link">
                <span className="list-name">{f.username}</span>
                <span className="mono list-count">friends since {fmtDate(f.since, tz)}</span>
              </Link>
              <div className="list-item-actions">
                <button
                  className="btn btn-ghost btn-danger"
                  disabled={busy}
                  aria-label={`Unfriend ${f.username}`}
                  title={`Unfriend ${f.username}`}
                  onClick={async () => {
                    const yes = await confirm({
                      title: `Unfriend ${f.username}?`,
                      message: "You'll stop seeing each other's activity. They won't be notified.",
                      confirmLabel: "Unfriend",
                      danger: true,
                    });
                    if (yes) await act(() => del(`/social/friends/${encodeURIComponent(f.username)}`))();
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Friends activity</h2>
      <ActivityFeed />
    </div>
  );
}
