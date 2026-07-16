import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApi, dropCached } from "../hooks";
import { api, post, put, del } from "../api";
import { useToast } from "../components/toast";
import { poster } from "../img";
import { useAuth } from "../app";
import { Empty, ErrorNote, PosterCard } from "../components/ui";
import { ListsGridSkeleton, ListDetailSkeleton } from "../components/skeleton";
import { mediaPath, publicListPath, idFromParam } from "../paths";
import {
  IconPlus,
  IconTrash,
  IconList,
  IconHeart,
  IconEye,
  IconEyeSlash,
  IconClose,
  IconPencil,
  IconWarning,
} from "../components/icons";
import { ListItems, ListByline, ListComments, type ListViewItem } from "../components/list-view";
import { ShareButton } from "../components/share";
import { isAnime } from "../../shared/anime";
import { useConfirm } from "../components/dialog";

interface ListSummary {
  id: number;
  name: string;
  kind: "custom" | "favorites";
  is_shared: number;
  count: number;
  posters: string[];
  // Only present when /lists is fetched with a title (issue #318): 1 if that
  // title is already in this list, so the add-to-list picker can pre-check it.
  has_item?: number;
}
// The owner list shares the visitor's rich item shape (issue #325): overview +
// per-item owner comment (issue #322) come through so the owner sees the same
// cards a visitor does. `genres_json`/`original_language` are extra fields the
// favorites Shows/Movies/Anime split needs (issue #103).
interface ListItem extends ListViewItem {
  // Present for the favorites view's Shows/Movies/Anime split (issue #103).
  genres_json?: string | null;
  original_language?: string | null;
}

export function ListsPage() {
  const { user } = useAuth();
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
        <ListsGridSkeleton />
      ) : error ? (
        <ErrorNote message={error} />
      ) : !data?.lists.length ? (
        <Empty title="No lists yet" hint="Make a list (“Comfort rewatches”, “Watch with Sam”) and fill it from any show or movie page." />
      ) : (
        <div className="lists-grid">
          {data.lists.map((l) => (
            <Link key={l.id} to={publicListPath(user!.username, l.id, l.name)} className="list-card">
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

// Rename a list inline (issue #321), mirroring the profile's username editor
// (profile.tsx): the pencil in the list header mounts just this form while
// editing, so the input and any error start fresh each open. `busy` lives in
// the parent so the pencil can't unmount the form (and eat the error)
// mid-save. On success the parent reloads /lists/:id, which re-runs the
// canonicalize effect and rewrites the URL slug (issue #319) to the new name.
function ListTitleEditor({
  id,
  name,
  reload,
  close,
  busy,
  setBusy,
}: {
  id: string;
  name: string;
  reload: () => void;
  close: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [value, setValue] = useState(name);
  const [err, setErr] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = value.trim();
    if (!next) return;
    if (next === name) {
      close();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await put(`/lists/${id}`, { name: next });
      // The /lists grid predates the rename — drop it so it can't repaint the
      // old name when the reader navigates back (issue #154).
      dropCached("/lists");
      close();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="username-form" onSubmit={save}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={60}
        aria-label="List title"
        autoFocus
        required
      />
      <button type="submit" className="btn" disabled={busy}>
        Save
      </button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
        Cancel
      </button>
      {err && <span className="email-err">{err}</span>}
    </form>
  );
}

// Owner-only "Danger zone" at the very bottom of the list (issue #336):
// deleting is irreversible, so the Delete button opens a confirmation modal
// (issue #336 follow-up) rather than deleting inline. The modal is built on the
// same native <dialog> chrome as the site-wide useConfirm dialog so it matches
// the rest of the site, and it stays a no-op until the owner types exactly
// "DELETE" (all caps) — that arms the destructive button. Escape, a backdrop
// click, and Cancel all close it without deleting, and the typed input resets
// every time it reopens. onConfirm navigates away on success, so we only reset
// busy on failure.
function DangerZone({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const armed = text === "DELETE"; // exact, case-sensitive match

  const open = () => {
    setText(""); // fresh confirmation every time the modal opens
    setBusy(false);
    ref.current?.showModal();
  };

  const close = () => {
    if (busy) return; // don't abandon an in-flight delete
    ref.current?.close();
  };

  const submit = async () => {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      // Success unmounts this page (navigates away); nothing else to do.
    } catch {
      // A failed delete keeps us here — reset so the owner can retry.
      setBusy(false);
    }
  };

  return (
    <section className="danger-zone">
      <h2 className="section-title danger-zone-title">
        <IconWarning size={14} /> Danger zone
      </h2>
      <p className="settings-hint danger-zone-hint">
        Deleting “{name}” can’t be undone. The shows and movies in it are unaffected.
      </p>
      <button type="button" className="btn btn-ghost btn-danger" onClick={open}>
        <IconTrash size={15} /> Delete
      </button>

      <dialog
        ref={ref}
        className="dialog"
        onClose={() => {
          setText("");
          setBusy(false);
        }}
        onCancel={(e) => {
          if (busy) e.preventDefault(); // block Escape mid-delete
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close(); // backdrop click = cancel
        }}
      >
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <h2>Delete “{name}”?</h2>
          <p>
            This can’t be undone. Type <strong>DELETE</strong> to confirm.
          </p>
          <input
            className="danger-zone-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Type DELETE in capitals to confirm deletion"
            autoFocus
          />
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-solid-danger" disabled={!armed || busy}>
              <IconTrash size={15} /> Delete
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

export function ListDetailPage() {
  // The URL is /u/:username/lists/:id-slug now (issue #319); only the leading
  // digits identify the list — the slug is advisory (see paths.ts).
  const id = idFromParam(useParams().id);
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirm();
  const toast = useToast();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<{
    list: {
      id: number;
      name: string;
      kind: "custom" | "favorites";
      is_shared: number;
      profile_position: number | null;
      preamble: string | null;
      comments_enabled: number;
    };
    items: ListItem[];
  }>(`/lists/${id}`);
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleBusy, setTitleBusy] = useState(false);
  // The comments eye-toggle updates optimistically (issue #336): flip locally,
  // then settle on the server. The override is cleared whenever fresh list data
  // lands (below), so a successful toggle + reload leaves the server's value in
  // charge and a failed one reverts.
  const [commentsBusy, setCommentsBusy] = useState(false);
  const [commentsOverride, setCommentsOverride] = useState<boolean | null>(null);
  useEffect(() => setCommentsOverride(null), [data]);

  // Canonicalize the address bar to the owner's slugged URL once the name is
  // known — this also finishes the /lists/:id redirect (which lands here
  // slugless) and fixes a stale slug or username casing, like the media pages.
  useEffect(() => {
    if (!data || !user) return;
    const canonical = publicListPath(user.username, data.list.id, data.list.name);
    if (location.pathname !== canonical) navigate(canonical + location.search, { replace: true });
  }, [data, user, location.pathname, location.search, navigate]);

  // The crumb is static — render it for real during the load so only the
  // list body is skeletal.
  if (loading)
    return (
      <div>
        <Link to="/lists" className="crumb">‹ Lists</Link>
        <ListDetailSkeleton />
      </div>
    );
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

  // Optimistic comments on/off (issue #336): flip the eye immediately, then
  // settle on the server; revert with a toast if the write fails.
  const commentsEnabled = commentsOverride ?? !!data.list.comments_enabled;
  async function toggleComments() {
    const next = !commentsEnabled;
    setCommentsOverride(next);
    setCommentsBusy(true);
    try {
      await put(`/lists/${id}/comments`, { enabled: next });
      toast(next ? "Comments are on" : "Comments are hidden");
      reload();
    } catch {
      setCommentsOverride(null); // back to the server's value
      toast("Couldn’t update comments", "error");
    } finally {
      setCommentsBusy(false);
    }
  }

  async function deleteList() {
    await del(`/lists/${id}`);
    // Mutate-then-navigate: the cached /lists grid (and this list's own entry)
    // predate the delete — drop them so the grid we land on can't flash the
    // deleted list (issue #154).
    dropCached("/lists");
    dropCached(`/lists/${id}`);
    toast("List deleted");
    navigate("/lists");
  }

  return (
    <div>
      <Link to="/lists" className="crumb">‹ Lists</Link>
      <div className="list-head">
        <div className="list-title-wrap">
          <h1 className="page-title">
            {data.list.kind === "favorites" && <IconHeart size={20} />} {data.list.name}
          </h1>
          {/* Icon-only share, right of the name (issue #319). The address bar
              is already the clean, shareable URL, so the old "Anyone with this
              link can view…" note and Copy-link button are gone. Only public
              lists are shareable — a private list's link just 404s a visitor. */}
          {!!data.list.is_shared && (
            <ShareButton
              variant="icon"
              title={data.list.name}
              text={`A list by ${user!.username} on Show Us TV.`}
              path={publicListPath(user!.username, data.list.id, data.list.name)}
            />
          )}
          {/* Rename the list inline (issue #321), same pencil affordance as the
              profile's username editor (profile.tsx). Owner-only: this whole
              page is the owner view — visitors get PublicListPage instead. */}
          <button
            className="icon-btn"
            disabled={titleBusy}
            aria-label="Edit list title"
            title="Edit list title"
            aria-expanded={editingTitle}
            onClick={() => setEditingTitle((v) => !v)}
          >
            <IconPencil size={15} />
          </button>
        </div>
        {/* Visibility stays at the top (issue #336): whether the list is public
            is the first decision, and it gates everything below it. Comments
            (an eye toggle) moved down by the comments; delete lives in the
            bottom Danger zone. */}
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
        </div>
      </div>

      {editingTitle && (
        <ListTitleEditor
          id={id}
          name={data.list.name}
          reload={reload}
          close={() => setEditingTitle(false)}
          busy={titleBusy}
          setBusy={setTitleBusy}
        />
      )}

      {/* Byline matches the visitor's view (issue #325) — the whole point is
          that the owner sees the same list a visitor does. Favorites carry no
          byline (they're organized into sections, not a single share). */}
      {data.list.kind !== "favorites" && <ListByline username={user!.username} count={data.items.length} />}

      <ListPreamble id={id} preamble={data.list.preamble} onSaved={reload} />

      {data.list.kind === "favorites" ? (
        !data.items.length ? (
          <Empty title="No favorites yet" hint="Tap the heart on any show or movie to add it here." />
        ) : (
          (() => {
            // Split favorites into Shows / Movies / Anime (issue #103); anime is
            // Animation genre + Japanese origin, matching the Library's Anime tab.
            const groups: Record<"shows" | "movies" | "anime", ListItem[]> = { shows: [], movies: [], anime: [] };
            for (const it of data!.items) {
              let g: string[] = [];
              try {
                const p = JSON.parse(it.genres_json ?? "[]");
                if (Array.isArray(p)) g = p;
              } catch {
                /* ignore malformed genres */
              }
              if (isAnime(g, it.original_language)) groups.anime.push(it);
              else if (it.type === "movie") groups.movies.push(it);
              else groups.shows.push(it);
            }
            const favSection = (title: string, items: ListItem[]) =>
              items.length > 0 ? (
                <section key={title} className="fav-section">
                  <h2 className="section-title">{title}</h2>
                  <div className="poster-grid">
                    {items.map((it) => (
                      <div key={`${it.type}-${it.id}`} className="lib-card fav-card">
                        <PosterCard
                          to={mediaPath(it.type, it.id, it.title)}
                          posterPath={it.poster}
                          title={it.title}
                          sub={it.type === "show" ? "TV" : "Movie"}
                        />
                        <button
                          className="btn btn-ghost btn-danger fav-remove"
                          disabled={busy}
                          onClick={act(() => del(`/lists/${id}/items/${it.type}/${it.id}`))}
                          aria-label={`Remove ${it.title} from favorites`}
                        >
                          <IconTrash size={14} /> Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null;
            return (
              <>
                {favSection("Favorite Shows", groups.shows)}
                {favSection("Favorite Movies", groups.movies)}
                {favSection("Favorite Anime", groups.anime)}
              </>
            );
          })()
        )
      ) : !data.items.length ? (
        <Empty title="This list is empty" hint="Open any show or movie and use “Add to list”." />
      ) : (
        // Same rich cards a visitor sees (issue #325) — descriptions and the
        // per-item owner comment (issue #322) — with the owner's reorder/remove
        // controls layered on via `controls`.
        <ListItems
          items={data.items}
          username={user!.username}
          controls={{
            busy,
            onMove: move,
            onRemove: (it) => act(() => del(`/lists/${id}/items/${it.type}/${it.id}`))(),
          }}
        />
      )}

      <ListComments
        id={data.list.id}
        commentsEnabled={commentsEnabled}
        isShared={!!data.list.is_shared}
        viewerSignedIn
        isOwner
        commentsBusy={commentsBusy}
        onToggleComments={toggleComments}
      />

      <DangerZone name={data.list.name} onConfirm={deleteList} />
    </div>
  );
}

// "Add to list" picker used on show/movie pages (issue #318). A scrollable,
// multi-select CHECKBOX menu of the viewer's custom lists — checked means the
// title is already in that list; toggling adds/removes it immediately
// (optimistic, with revert-on-error). The Favorites system list is deliberately
// excluded: favorites are managed by the heart button on the detail page.
//
// Built on a native <dialog> (like the confirm dialog) so it lives in the top
// layer — it can't be clipped by the hero card's overflow:hidden, gets Escape
// + backdrop-dismiss + focus handling for free, and renders as a compact panel
// on desktop / a bottom sheet on phones. Replaces the old native <select>,
// which read as a single-select with an "Add to list…"/"Added ✓" placeholder
// and native prev/next paging.
export function AddToList({ type, id }: { type: "show" | "movie"; id: number }) {
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Lazy-load on first open, fetching membership for THIS title so each row
  // renders its checked state. Uses api() (not useApi) — this per-title query
  // is distinct from the /lists page cache and shouldn't seed it.
  function load() {
    setLoadError(false);
    api<{ lists: ListSummary[] }>(`/lists?type=${type}&id=${id}`)
      .then((d) => setLists(d.lists))
      .catch(() => setLoadError(true));
  }

  function openMenu() {
    if (lists === null && !loadError) load();
    setOpen(true);
  }

  // Mirror the confirm dialog: render the <dialog>, then showModal() once it's
  // mounted so it enters the top layer with a backdrop + focus trap.
  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);

  // Favorites never appear here — the heart button owns them (issue #318).
  const custom = (lists ?? []).filter((l) => l.kind !== "favorites");

  async function toggle(l: ListSummary) {
    if (busyId !== null) return;
    const has = !!l.has_item;
    setBusyId(l.id);
    const flip = (on: boolean) =>
      setLists((prev) =>
        prev?.map((x) => (x.id === l.id ? { ...x, has_item: on ? 1 : 0, count: x.count + (on ? 1 : -1) } : x)) ?? prev
      );
    flip(!has); // optimistic
    try {
      if (has) await del(`/lists/${l.id}/items/${type}/${id}`);
      else await post(`/lists/${l.id}/items`, { type, id });
      // These mutations happen away from the Lists pages, so drop their cached
      // copies — the grid count and the list's items can't render stale (#154).
      dropCached("/lists");
      dropCached(`/lists/${l.id}`);
    } catch {
      flip(has); // revert
      toast(has ? "Couldn't remove from list" : "Couldn't add to list", "error");
    } finally {
      setBusyId(null);
    }
  }

  // Create a new list and drop the title straight into it — the natural intent
  // when you make a list from a title's page. Also covers the empty state
  // (no custom lists yet).
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const made = (await post("/lists", { name })) as { id: number; name: string };
      await post(`/lists/${made.id}/items`, { type, id });
      dropCached("/lists");
      dropCached(`/lists/${made.id}`);
      setLists((prev) => [
        ...(prev ?? []),
        { id: made.id, name: made.name, kind: "custom", is_shared: 0, count: 1, posters: [], has_item: 1 },
      ]);
      setNewName("");
      toast(`Added to “${made.name}”`);
    } catch {
      toast("Couldn't create list", "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost add-to-list-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
      >
        <IconList size={16} /> Add to list
      </button>
      {open && (
        <dialog
          ref={ref}
          className="atl-dialog"
          aria-label="Add to lists"
          onClose={() => setOpen(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) ref.current?.close(); // backdrop tap
          }}
        >
          <div className="atl-body">
            <div className="atl-head">
              <h2>Add to lists</h2>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
                <IconClose size={18} />
              </button>
            </div>

            <div className="atl-scroll">
              {loadError ? (
                <p className="atl-msg">
                  Couldn’t load your lists.{" "}
                  <button className="link-btn" onClick={load}>
                    Retry
                  </button>
                </p>
              ) : lists === null ? (
                <p className="atl-msg">Loading…</p>
              ) : custom.length === 0 ? (
                <p className="atl-msg">No lists yet — create one below.</p>
              ) : (
                custom.map((l) => (
                  <label key={l.id} className="atl-row">
                    <input
                      type="checkbox"
                      checked={!!l.has_item}
                      // Disable every row while one toggle is in flight: a
                      // controlled checkbox whose onChange no-ops would desync
                      // from its bound value, and toggles are quick anyway.
                      disabled={busyId !== null}
                      onChange={() => toggle(l)}
                    />
                    <span className="atl-name">{l.name}</span>
                    <span className="mono atl-count">{l.count}</span>
                  </label>
                ))
              )}
            </div>

            <form className="atl-create" onSubmit={create}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New list name"
                maxLength={60}
                aria-label="New list name"
              />
              <button type="submit" className="btn" disabled={creating || !newName.trim()}>
                <IconPlus size={16} /> Create
              </button>
            </form>
          </div>
        </dialog>
      )}
    </>
  );
}
