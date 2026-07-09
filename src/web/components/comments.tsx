// Reddit-style comment threads: up/down votes, best/top/new sorts, collapse,
// [deleted] placeholders, and the two large-thread stubs — "load more
// comments (n)" for siblings beyond the page budget and "continue this
// thread" below the depth cap. The server shapes the tree; this component
// keeps a local copy so votes, replies, deletes, and stub expansions splice
// in without refetching (a refetch would also lose collapse state).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post, put, del } from "../api";
import { useApi } from "../hooks";
import { useAuth } from "../app";
import { fmtAgo, fmtDateTime } from "../format";
import { COMMENT_MAX_LEN, COMMENT_URL_RE } from "../../shared/constants";
import { ErrorNote } from "./ui";
import { CommentsSkeleton } from "./skeleton";
import { IconArrowUp, IconArrowDown } from "./icons";

interface MoreStub {
  count: number;
  ids: number[];
}

interface CommentNode {
  id: number;
  user: string | null; // null → [deleted] (comment or account)
  mine: boolean;
  body: string | null;
  score: number;
  myVote: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  children: CommentNode[];
  more: MoreStub | null;
  deep: number; // hidden descendants below the depth cap
}

interface Listing {
  comments: CommentNode[];
  more: MoreStub | null;
  count: number;
}

type Sort = "top" | "best" | "new";
const SORT_TABS: [Sort, string][] = [
  ["top", "Top"],
  ["best", "Best"],
  ["new", "New"],
];

interface Act {
  vote: (id: number, value: number, prev: { myVote: number; score: number }) => void;
  reply: (parentId: number, body: string) => Promise<void>;
  edit: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  loadMore: (parentId: number | null, stub: MoreStub) => Promise<void>;
  continueThread: (id: number) => Promise<void>;
}

// Replace node `id` anywhere in the tree. Trees are page-budget-sized, so a
// full recursive map is fine.
function patchTree(list: CommentNode[], id: number, fn: (n: CommentNode) => CommentNode): CommentNode[] {
  return list.map((n) => {
    if (n.id === id) return fn(n);
    if (!n.children.length) return n;
    return { ...n, children: patchTree(n.children, id, fn) };
  });
}

// Everything under a comment: loaded children plus both stub counts.
function hiddenCount(n: CommentNode): number {
  let c = n.children.length + (n.more?.count ?? 0) + n.deep;
  for (const ch of n.children) c += hiddenCount(ch);
  return c;
}

export function Comments({ targetType, targetId }: { targetType: "episode" | "movie" | "show" | "list"; targetId: number }) {
  const { user } = useAuth();
  const verified = !!user?.emailVerified; // server enforces too (403)
  const [sort, setSort] = useState<Sort>("top");
  const { data, loading, error } = useApi<Listing>(`/comments/${targetType}/${targetId}?sort=${sort}`);
  const [thread, setThread] = useState<Listing | null>(null);
  useEffect(() => setThread(data), [data]);

  const patch = (id: number, fn: (n: CommentNode) => CommentNode) =>
    setThread((t) => t && { ...t, comments: patchTree(t.comments, id, fn) });

  const act: Act = {
    // Optimistic: apply the delta now, settle on the server's score, revert
    // on failure (Reddit doesn't error-toast votes either).
    vote: async (id, value, prev) => {
      patch(id, (n) => ({ ...n, myVote: value, score: n.score - n.myVote + value }));
      try {
        const r = await put(`/comments/${id}/vote`, { value });
        patch(id, (n) => ({ ...n, score: r.score }));
      } catch {
        patch(id, (n) => ({ ...n, myVote: prev.myVote, score: prev.score }));
      }
    },
    // Your new comment goes straight to the top of its siblings, like Reddit.
    reply: async (parentId, body) => {
      const r = await post("/comments", { target_type: targetType, target_id: targetId, body, parent_id: parentId });
      setThread((t) => {
        if (!t) return t;
        return {
          ...t,
          count: t.count + 1,
          comments: patchTree(t.comments, parentId, (n) => ({ ...n, children: [r.comment, ...n.children] })),
        };
      });
    },
    edit: async (id, body) => {
      const r = await put(`/comments/${id}`, { body });
      patch(id, (n) => ({ ...n, body: r.body, editedAt: r.editedAt }));
    },
    // Local mirror of the server's soft delete: the node becomes [deleted]
    // in place; the next full load prunes it if nothing hangs below.
    remove: async (id) => {
      await del(`/comments/${id}`);
      patch(id, (n) => ({ ...n, deleted: true, user: null, body: null, mine: false, myVote: 0 }));
    },
    loadMore: async (parentId, stub) => {
      const r = await api<{ comments: CommentNode[]; more: MoreStub | null }>("/comments/more", {
        method: "POST",
        body: JSON.stringify({ target_type: targetType, target_id: targetId, ids: stub.ids, sort }),
      });
      setThread((t) => {
        if (!t) return t;
        if (parentId == null) return { ...t, comments: [...t.comments, ...r.comments], more: r.more };
        return {
          ...t,
          comments: patchTree(t.comments, parentId, (n) => ({ ...n, children: [...n.children, ...r.comments], more: r.more })),
        };
      });
    },
    continueThread: async (id) => {
      const r = await api<{ comments: CommentNode[]; more: MoreStub | null }>(`/comments/${id}/thread?sort=${sort}`);
      patch(id, (n) => ({ ...n, deep: 0, children: r.comments, more: r.more }));
    },
  };

  const postTopLevel = async (body: string) => {
    const r = await post("/comments", { target_type: targetType, target_id: targetId, body });
    setThread((t) => t && { ...t, count: t.count + 1, comments: [r.comment, ...t.comments] });
  };

  return (
    <section className="comments">
      <div className="comments-head">
        <h2>
          Comments {thread && <span className="comments-count mono">({thread.count})</span>}
        </h2>
        <div className="comments-sort" role="radiogroup" aria-label="Sort comments">
          {SORT_TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={sort === key}
              className={`sort-tab${sort === key ? " is-on" : ""}`}
              onClick={() => setSort(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!user ? (
        // Anonymous readers (shared links, issue #159) can read the thread but
        // not write — a quiet sign-in line stands in for the composer.
        <p className="comments-gate">
          <Link to="/login">Sign in</Link> to join the conversation.
        </p>
      ) : verified ? (
        <Composer placeholder="What did you think?" submitLabel="Comment" onSubmit={postTopLevel} />
      ) : (
        <p className="comments-gate">
          Verify your email to join the conversation: <Link to="/profile">go to your profile</Link>.
        </p>
      )}
      {error ? (
        <ErrorNote message={error} />
      ) : !thread ? (
        loading ? (
          <CommentsSkeleton />
        ) : null
      ) : thread.comments.length === 0 ? (
        // "Start the thread" only makes sense for someone who can write.
        <p className="comments-empty">{user ? "No comments yet. Start the thread." : "No comments yet."}</p>
      ) : (
        <div className="comment-list">
          {thread.comments.map((n) => (
            <CommentItem key={n.id} node={n} act={act} />
          ))}
          {thread.more && (
            <AsyncLink label={`load more comments (${thread.more.count})`} onClick={() => act.loadMore(null, thread.more!)} />
          )}
        </div>
      )}
    </section>
  );
}

function CommentItem({ node: n, act }: { node: CommentNode; act: Act }) {
  const { user } = useAuth();
  const verified = !!user?.emailVerified;
  const [collapsed, setCollapsed] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  // null = closed; [] while loading (renders nothing until versions land)
  const [history, setHistory] = useState<{ body: string; editedAt: string }[] | null>(null);

  const toggleHistory = async () => {
    if (history) return setHistory(null);
    setHistory([]);
    try {
      const r = await api<{ versions: { body: string; editedAt: string }[] }>(`/comments/${n.id}/history`);
      setHistory(r.versions);
    } catch {
      setHistory(null);
    }
  };

  // No profile timezone for a signed-out reader — the browser's own is the
  // stand-in for the exact-time tooltips (issue #159).
  const tz = user?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const author = n.user ?? "[deleted]";
  const points = `${n.score} ${n.score === 1 || n.score === -1 ? "point" : "points"}`;
  const when = (
    <span className="comment-time mono" title={fmtDateTime(n.createdAt, tz)}>
      {fmtAgo(n.createdAt)}
    </span>
  );

  if (collapsed) {
    const hidden = hiddenCount(n);
    return (
      <div className="comment is-collapsed">
        <button type="button" className="collapse-btn mono" aria-expanded={false} onClick={() => setCollapsed(false)}>
          [+]
        </button>
        <span className={`comment-user${n.user ? "" : " is-deleted"}`}>{author}</span>
        <span className="comment-score mono">{points}</span>
        {when}
        {hidden > 0 && <span className="mono">({hidden} {hidden === 1 ? "child" : "children"})</span>}
      </div>
    );
  }

  return (
    <div className="comment">
      <div className="comment-vote">
        <button
          type="button"
          className={`vote-btn up${n.myVote === 1 ? " is-on" : ""}`}
          aria-pressed={n.myVote === 1}
          aria-label="Upvote"
          disabled={n.deleted || !verified}
          onClick={() => act.vote(n.id, n.myVote === 1 ? 0 : 1, n)}
        >
          <IconArrowUp size={13} />
        </button>
        <button
          type="button"
          className={`vote-btn down${n.myVote === -1 ? " is-on" : ""}`}
          aria-pressed={n.myVote === -1}
          aria-label="Downvote"
          disabled={n.deleted || !verified}
          onClick={() => act.vote(n.id, n.myVote === -1 ? 0 : -1, n)}
        >
          <IconArrowDown size={13} />
        </button>
      </div>
      <div className="comment-main">
        <div className="comment-head">
          <button type="button" className="collapse-btn mono" aria-expanded onClick={() => setCollapsed(true)}>
            [–]
          </button>
          <span className={`comment-user${n.user ? "" : " is-deleted"}`}>{author}</span>
          <span className="comment-score mono">{points}</span>
          {when}
          {n.editedAt && (
            <button
              type="button"
              className="link-btn edited-marker mono"
              title={fmtDateTime(n.editedAt, tz)}
              aria-expanded={!!history}
              onClick={toggleHistory}
            >
              edited {fmtAgo(n.editedAt)}*
            </button>
          )}
        </div>
        {editing ? (
          <Composer
            placeholder="Edit your comment"
            submitLabel="Save"
            initial={n.body ?? ""}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              await act.edit(n.id, body);
              setHistory(null); // an open panel is stale now — reopen refetches
            }}
          />
        ) : (
          <p className={`comment-body${n.deleted ? " is-deleted" : ""}`}>{n.deleted ? "[deleted]" : n.body}</p>
        )}
        {history && history.length > 0 && (
          <div className="comment-history">
            {history.map((v, i) => (
              <p key={i} className="comment-history-item">
                <span className="mono" title={fmtDateTime(v.editedAt, tz)}>
                  until {fmtAgo(v.editedAt)}:
                </span>{" "}
                {v.body}
              </p>
            ))}
          </div>
        )}
        <div className="comment-actions">
          {!n.deleted && verified && (
            <button type="button" className="link-btn" onClick={() => setReplying((r) => !r)}>
              reply
            </button>
          )}
          {n.mine && !editing && (
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>
              edit
            </button>
          )}
          {n.mine &&
            (confirmDel ? (
              <span className="mono">
                delete?{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => act.remove(n.id).catch((e) => setActErr(e.message)).finally(() => setConfirmDel(false))}
                >
                  yes
                </button>{" "}
                /{" "}
                <button type="button" className="link-btn" onClick={() => setConfirmDel(false)}>
                  no
                </button>
              </span>
            ) : (
              <button type="button" className="link-btn" onClick={() => setConfirmDel(true)}>
                delete
              </button>
            ))}
          {actErr && <span className="comment-err">{actErr}</span>}
        </div>
        {replying && (
          <Composer
            placeholder={`Reply to ${author}`}
            submitLabel="Reply"
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={(body) => act.reply(n.id, body)}
          />
        )}
        {(n.children.length > 0 || n.more || n.deep > 0) && (
          <div className="comment-children">
            {n.children.map((ch) => (
              <CommentItem key={ch.id} node={ch} act={act} />
            ))}
            {n.more && (
              <AsyncLink label={`load more comments (${n.more.count})`} onClick={() => act.loadMore(n.id, n.more!)} />
            )}
            {n.deep > 0 && (
              <AsyncLink label={`continue this thread → (${n.deep})`} onClick={() => act.continueThread(n.id)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  initial,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  initial?: string; // editing an existing comment starts from its body
}) {
  const [text, setText] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const left = COMMENT_MAX_LEN - text.length;

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (COMMENT_URL_RE.test(body)) {
      setErr("Links aren't allowed in comments");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(body);
      setText("");
      onCancel?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        maxLength={COMMENT_MAX_LEN}
        rows={3}
        autoFocus={autoFocus}
      />
      <div className="composer-foot">
        {err && <span className="composer-err">{err}</span>}
        {left <= 200 && <span className="mono">{left}</span>}
        <div className="composer-actions">
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn" disabled={busy || !text.trim()}>
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

// Link-styled async action that disables itself while in flight; failures
// (offline, mostly) just re-enable the link.
function AsyncLink({ label, onClick }: { label: string; onClick: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link-btn thread-stub"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch {
          /* leave the stub for a retry */
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}
