// Shared list presentation (issue #325): the owner's editable list and a
// visitor's read-only share once diverged — the owner saw bare numbered rows,
// visitors saw rich cards with descriptions and the owner's per-item comment
// (issue #322). They now render the SAME content through these components, so
// the owner sees exactly what a visitor sees; the only difference is that the
// owner view layers its controls on top (reorder/remove per item here, plus the
// header management buttons in lists.tsx). Both routes feed the same normalized
// shape — the owner endpoint now returns overview + ownerComment too.
import { Link } from "react-router-dom";
import { poster } from "../img";
import { mediaPath } from "../paths";
import { Comments } from "../components/comments";
import { IconArrowUp, IconArrowDown, IconTrash } from "./icons";

export interface ListViewItem {
  type: "show" | "movie";
  id: number;
  title: string;
  poster: string | null;
  overview: string | null;
  // The list owner's own top-level comment on this title (issue #322), if any:
  // shown read-only and linking to the title page where the comment lives.
  ownerComment: { body: string; createdAt: string; editedAt: string | null } | null;
}

// Owner-only affordances, layered onto the shared card when the viewer owns the
// list. Absent for visitors, whose cards are pure content.
export interface ListItemControls {
  busy: boolean;
  onMove: (index: number, delta: number) => void;
  onRemove: (item: ListViewItem) => void;
}

function ListItemCard({
  item,
  username,
  index,
  count,
  controls,
}: {
  item: ListViewItem;
  username: string;
  index: number;
  count: number;
  controls?: ListItemControls;
}) {
  const src = poster(item.poster);
  const to = mediaPath(item.type, item.id, item.title);
  return (
    <li className="pub-list-item">
      <Link to={to} className="pub-list-poster" aria-label={`View ${item.title}`}>
        {src ? <img src={src} alt="" loading="lazy" /> : <div className="poster-fallback">{item.title}</div>}
      </Link>
      <div className="pub-list-body">
        <Link to={to} className="pub-list-title">
          {item.title}
        </Link>
        <span className="pub-list-type">{item.type === "show" ? "TV" : "Movie"}</span>
        {item.overview && <p className="pub-list-overview">{item.overview}</p>}
        {/* The owner's own top-level comment on this title (issue #322),
            read-only: no composer, vote, or reply — the whole block just links
            to the title page where the comment lives and where a reader can
            actually join the thread. */}
        {item.ownerComment && (
          <Link to={to} className="pub-list-comment" title={`Read ${username}’s comment on ${item.title}`}>
            <span className="pub-list-comment-body">{item.ownerComment.body}</span>
            <span className="pub-list-comment-src mono">— {username} · view on title ↗</span>
          </Link>
        )}
      </div>
      {controls && (
        <div className="pub-list-actions">
          <button
            className="btn btn-ghost"
            disabled={controls.busy || index === 0}
            onClick={() => controls.onMove(index, -1)}
            aria-label="Move up"
          >
            <IconArrowUp size={14} />
          </button>
          <button
            className="btn btn-ghost"
            disabled={controls.busy || index === count - 1}
            onClick={() => controls.onMove(index, 1)}
            aria-label="Move down"
          >
            <IconArrowDown size={14} />
          </button>
          <button
            className="btn btn-ghost btn-danger"
            disabled={controls.busy}
            onClick={() => controls.onRemove(item)}
            aria-label={`Remove ${item.title}`}
          >
            <IconTrash size={16} />
          </button>
        </div>
      )}
    </li>
  );
}

// The single source of truth for list-item rendering, used by both the owner
// (lists.tsx) and public (public-list.tsx) routes. Pass `controls` to layer the
// owner's reorder/remove buttons onto each card; omit it for the read-only view.
export function ListItems({
  items,
  username,
  controls,
}: {
  items: ListViewItem[];
  username: string;
  controls?: ListItemControls;
}) {
  return (
    <ul className="pub-list">
      {items.map((it, i) => (
        <ListItemCard
          key={`${it.type}-${it.id}`}
          item={it}
          username={username}
          index={i}
          count={items.length}
          controls={controls}
        />
      ))}
    </ul>
  );
}

// The "A list by X · N titles" byline, identical on both routes.
export function ListByline({ username, count }: { username: string; count: number }) {
  return (
    <p className="public-byline">
      {/* Always linked: a private profile renders its teaser now (issue #158)
          instead of 404ing, so the link is safe. */}
      A list by <Link to={`/u/${username}`}>{username}</Link> · {count} {count === 1 ? "title" : "titles"}
    </p>
  );
}

// The list comments section (issue #98), unified across both routes. Comments
// only surface on a public list; the owner viewing a private list sees the note
// instead, and a signed-out visitor is prompted to sign in. This mirrors the
// exact gating both pages used before they were merged.
export function ListComments({
  id,
  commentsEnabled,
  isShared,
  viewerSignedIn,
}: {
  id: number;
  commentsEnabled: boolean;
  isShared: boolean;
  viewerSignedIn: boolean;
}) {
  if (!commentsEnabled) return null;
  if (!isShared)
    return (
      <p className="settings-hint list-comments-note">Comments are on, but they only appear once this list is public.</p>
    );
  if (!viewerSignedIn)
    return (
      <p className="settings-hint list-comments-note">
        <Link to="/login">Sign in</Link> to read and post comments on this list.
      </p>
    );
  return (
    <section className="list-comments">
      <h2 className="section-title">Comments</h2>
      <Comments targetType="list" targetId={id} />
    </section>
  );
}
