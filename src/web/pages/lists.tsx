import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../hooks";
import { api, post, put, del } from "../api";
import { poster } from "../img";
import { useAuth } from "../app";
import { Spinner, Empty, ErrorNote, PosterCard } from "../components/ui";
import { mediaPath, publicListPath } from "../paths";
import {
  IconPlus,
  IconTrash,
  IconList,
  IconHeart,
  IconEye,
  IconEyeSlash,
  IconArrowUp,
  IconArrowDown,
} from "../components/icons";
import { useConfirm } from "../components/dialog";

interface ListSummary {
  id: number;
  name: string;
  kind: "custom" | "favorites";
  is_shared: number;
  count: number;
  posters: string[];
}
interface ListItem {
  type: "show" | "movie";
  id: number;
  title: string;
  poster: string | null;
}

export function ListsPage() {
  const { data, loading, error, reload } = useApi<{ lists: ListSummary[] }>("/lists");
  const [creating, setCreating] = useState(false);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = (new FormData(e.currentTarget).get("name") as string).trim();
    if (!name) return;
    setCreating(true);
    try {
      await post("/lists", { name });
      (e.target as HTMLFormElement).reset();
      reload();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Lists</h1>
      <form className="list-create" onSubmit={create}>
        <input name="name" placeholder="New list name" maxLength={60} aria-label="New list name" required />
        <button className="btn" disabled={creating}>
          <IconPlus size={16} /> Create list
        </button>
      </form>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorNote message={error} />
      ) : !data?.lists.length ? (
        <Empty title="No lists yet" hint="Make a list (“Comfort rewatches”, “Watch with Sam”) and fill it from any show or movie page." />
      ) : (
        <div className="lists-grid">
          {data.lists.map((l) => (
            <Link key={l.id} to={`/lists/${l.id}`} className="list-card">
              <div className="list-collage">
                {l.posters.length ? (
                  l.posters.map((p, i) => <img key={i} src={poster(p, "w154")!} alt="" loading="lazy" />)
                ) : (
                  <IconList size={28} />
                )}
              </div>
              <span className="list-name">
                {l.kind === "favorites" && <IconHeart size={13} />} {l.name}
              </span>
              <span className="mono list-count">
                {l.count} {l.count === 1 ? "title" : "titles"}
                {l.is_shared ? " · public" : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Optional list preamble (issue #94): the owner can add a short note about the
// list. Shown here and on the public share page. Empty saves clear it.
function ListPreamble({ id, preamble, onSaved }: { id: string; preamble: string | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(preamble ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await put(`/lists/${id}/preamble`, { preamble: draft.trim() || null });
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="list-preamble-edit">
        <textarea
          className="list-preamble-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Say why you made this list or what makes it worth a look…"
          aria-label="List preamble"
        />
        <div className="list-preamble-actions">
          <button className="btn" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            className="btn btn-ghost"
            disabled={saving}
            onClick={() => {
              setDraft(preamble ?? "");
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return preamble ? (
    <p className="list-preamble">
      {preamble}{" "}
      <button className="link-btn" onClick={() => setEditing(true)}>
        Edit
      </button>
    </p>
  ) : (
    <button className="link-btn list-preamble-add" onClick={() => setEditing(true)}>
      + Add a preamble
    </button>
  );
}

export function ListDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<{
    list: {
      id: number;
      name: string;
      kind: "custom" | "favorites";
      is_shared: number;
      profile_position: number | null;
      preamble: string | null;
    };
    items: ListItem[];
  }>(`/lists/${id}`);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
      reload();
    } finally {
      setBusy(false);
    }
  };

  // Making a pinned list private removes it from the profile (issue #33), so
  // warn first. The server clears the pin either way; this just surfaces it.
  async function toggleVisibility() {
    const goingPrivate = !!data!.list.is_shared;
    if (goingPrivate && data!.list.profile_position != null) {
      const ok = await confirm({
        title: `Make “${data!.list.name}” private?`,
        message: "This list is pinned to your profile. Making it private will remove it from your profile.",
        confirmLabel: "Make private",
        cancelLabel: "Keep public",
        danger: true,
      });
      if (!ok) return;
    }
    await act(() => put(`/lists/${id}/visibility`, { public: !data!.list.is_shared }))();
  }

  const publicUrl = `${window.location.origin}${publicListPath(user!.username, data.list.id, data.list.name)}`;

  async function move(index: number, delta: number) {
    const items = [...data!.items];
    const [it] = items.splice(index, 1);
    items.splice(index + delta, 0, it);
    setBusy(true);
    try {
      await put(`/lists/${id}/order`, { items: items.map((i) => ({ type: i.type, id: i.id })) });
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/lists" className="crumb">‹ Lists</Link>
      <div className="list-head">
        <h1 className="page-title">
          {data.list.kind === "favorites" && <IconHeart size={20} />} {data.list.name}
        </h1>
        <div className="list-head-actions">
          <button
            className="btn btn-ghost"
            disabled={busy}
            aria-pressed={!!data.list.is_shared}
            title={data.list.is_shared ? "Public: anyone with the link can view" : "Private: only you can view"}
            onClick={toggleVisibility}
          >
            {data.list.is_shared ? <IconEye size={15} /> : <IconEyeSlash size={15} />}
            {data.list.is_shared ? "Public" : "Private"}
          </button>
          <button
            className="btn btn-ghost btn-danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: `Delete “${data.list.name}”?`,
                message: "The shows and movies in it are unaffected.",
                confirmLabel: "Delete list",
                danger: true,
              });
              if (!ok) return;
              await del(`/lists/${id}`);
              navigate("/lists");
            }}
          >
            <IconTrash size={15} /> Delete list
          </button>
        </div>
      </div>

      {!!data.list.is_shared && (
        <p className="share-note">
          Anyone with this link can view:{" "}
          <a href={publicUrl}>{publicUrl}</a>{" "}
          <button
            className="link-btn"
            onClick={async () => {
              await navigator.clipboard.writeText(publicUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
        </p>
      )}

      <ListPreamble id={id!} preamble={data.list.preamble} onSaved={reload} />

      {!data.items.length ? (
        <Empty title="This list is empty" hint="Open any show or movie and use “Add to list”." />
      ) : (
        <ul className="list-items">
          {data.items.map((it, i) => (
            <li key={`${it.type}-${it.id}`}>
              <span className="mono list-pos">{i + 1}</span>
              <PosterCard to={mediaPath(it.type, it.id, it.title)} posterPath={it.poster} title={it.title} sub={it.type === "show" ? "TV" : "Movie"} />
              <div className="list-item-actions">
                <button className="btn btn-ghost" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <IconArrowUp size={14} />
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy || i === data.items.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  <IconArrowDown size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-danger"
                  disabled={busy}
                  onClick={act(() => del(`/lists/${id}/items/${it.type}/${it.id}`))}
                  aria-label={`Remove ${it.title}`}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "Add to list" dropdown used on show/movie pages. Lazy-loads the lists on open.
export function AddToList({ type, id }: { type: "show" | "movie"; id: number }) {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  return (
    <select
      className="add-to-list"
      aria-label="Add to list"
      value=""
      onFocus={() => {
        if (lists === null) api<{ lists: ListSummary[] }>("/lists").then((d) => setLists(d.lists));
      }}
      onChange={async (e) => {
        const listId = e.target.value;
        if (!listId) return;
        await post(`/lists/${listId}/items`, { type, id });
        setAdded(listId);
      }}
    >
      <option value="">{added ? "Added ✓" : "Add to list…"}</option>
      {(lists ?? []).map((l) => (
        <option key={l.id} value={l.id}>{l.name}</option>
      ))}
    </select>
  );
}
