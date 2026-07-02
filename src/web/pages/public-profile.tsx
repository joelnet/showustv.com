// Public, read-only profile — reachable without an account at /u/:username
// when the owner has made their profile public. Shows watch stats plus the
// lists they pinned (public lists only). Signed-in visitors also get a
// friend/unfriend affordance here.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, post, del } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { useConfirm } from "../components/dialog";
import { poster } from "../img";
import { Spinner, Wordmark, SmpteBars, ErrorNote } from "../components/ui";
import { IconList, IconCheck, IconPlus } from "../components/icons";
import { StatsGrid, type WatchStats } from "./profile";

interface PublicProfile {
  username: string;
  stats: WatchStats;
  lists: { id: number; name: string; count: number; posters: string[] }[];
}

type Relation = "none" | "outgoing" | "incoming" | "friends" | "self";

// Friend/unfriend affordance, shown only to signed-in visitors on someone
// else's profile. Social actions never queue offline — failures show inline.
function FriendActions({ username }: { username: string }) {
  const confirm = useConfirm();
  const [relation, setRelation] = useState<Relation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRelation(null);
    api<{ user: { username: string; relation: Relation } | null }>(`/social/search?q=${encodeURIComponent(username)}`)
      .then((d) => live && setRelation(d.user?.relation ?? null))
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
    <div className="public-actions">
      {relation === "none" && (
        <button className="btn" disabled={busy} onClick={act(() => post("/social/requests", { username }), "outgoing")}>
          <IconPlus size={15} /> Add friend
        </button>
      )}
      {relation === "outgoing" && (
        <>
          <span className="friend-note">Friend request sent</span>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={act(() => del(`/social/requests/${encodeURIComponent(username)}`), "none")}
          >
            Cancel request
          </button>
        </>
      )}
      {relation === "incoming" && (
        <>
          <span className="friend-note">{username} sent you a friend request</span>
          <button
            className="btn"
            disabled={busy}
            onClick={act(() => post(`/social/requests/${encodeURIComponent(username)}/accept`), "friends")}
          >
            <IconCheck size={14} /> Accept
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={act(() => del(`/social/requests/${encodeURIComponent(username)}`), "none")}
          >
            Decline
          </button>
        </>
      )}
      {relation === "friends" && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          title={`You and ${username} are friends — click to unfriend`}
          onClick={async () => {
            const yes = await confirm({
              title: `Unfriend ${username}?`,
              message: "You'll stop seeing each other's activity. They won't be notified.",
              confirmLabel: "Unfriend",
              danger: true,
            });
            if (yes) await act(() => del(`/social/friends/${encodeURIComponent(username)}`), "none")();
          }}
        >
          <IconCheck size={14} /> Friends
        </button>
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
        <Link to="/" className="header-brand" aria-label="Show Us TV — home">
          <Wordmark />
        </Link>
      </header>
      <main className="main">
        {loading ? (
          <Spinner />
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
            {user && <FriendActions username={data.username} />}
            <StatsGrid stats={data.stats} />
            {data.lists.length > 0 && (
              <>
                <h2 className="section-title">Lists</h2>
                <div className="lists-grid">
                  {data.lists.map((l) => (
                    <Link key={l.id} to={`/u/${username}/lists/${l.id}`} className="list-card">
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
      <footer className="footer">
        <span>
          This product uses the <a href="https://www.themoviedb.org">TMDB</a> API but is not endorsed or
          certified by TMDB.
        </span>
      </footer>
    </div>
  );
}
