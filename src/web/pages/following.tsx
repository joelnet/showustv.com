// Following (issue #39): follow people by username, and see who follows you.
// Instagram-style asymmetric follows — no accept step, and following isn't
// mutual. Pairs that DO follow each other surface in a Mutuals section
// (issue #130).
//
// Social mutations are deliberately NOT offline-queueable (api.ts only queues
// watch/favorite ops) — when the network is gone they fail fast and the error
// is shown inline instead of pretending to succeed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { post, del } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { Empty, ErrorNote } from "../components/ui";
import { FollowingSkeleton } from "../components/skeleton";
import { IconPlus, IconShare, IconTrash } from "../components/icons";

interface FollowsData {
  mutuals: { username: string; since: string }[];
  following: { username: string; since: string }[];
  followers: { username: string; since: string; youFollow: boolean }[];
}

// Follow dates render date-only in the viewer's profile timezone.
function fmtDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });
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

      {/* Shared Signal (issue #284): the entry point sits at the top, right
          after the follow form. The linked page handles the no-mutuals case
          with its own empty state, so the link always shows. */}
      <Link to="/following/shared" className="shared-signal-link">
        <IconShare size={13} /> Shared Signal
      </Link>

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
                      message: "You'll stop seeing their activity. They won't be notified.",
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
    </div>
  );
}
