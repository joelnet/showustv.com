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
  IconArrowUp,
  IconArrowDown,
  IconComment,
  IconClose,
} from "../components/icons";
import { Comments } from "../components/comments";
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
interface ListItem {
  type: "show" | "movie";
  id: number;
  title: string;
  poster: string | null;
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

export function ListDetailPage() {
  // The URL is /u/:username/lists/:id-slug now (issue #319); only the leading
  // digits identify the list — the slug is advisory (see paths.ts).
  const id = idFromParam(useParams().id);
  const navigate = useNavigate();
  const location = useLocation();
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
      comments_enabled: number;
    };
    items: ListItem[];
  }>(`/lists/${id}`);
  const [busy, setBusy] = useState(false);

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
        </div>
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
            className="btn btn-ghost"
            disabled={busy}
            aria-pressed={!!data.list.comments_enabled}
            title={data.list.comments_enabled ? "Comments are on for this list" : "Comments are off"}
            onClick={act(() => put(`/lists/${id}/comments`, { enabled: !data.list.comments_enabled }))}
          >
            <IconComment size={15} /> {data.list.comments_enabled ? "Comments on" : "Comments off"}
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
              // Mutate-then-navigate: the cached /lists grid (and this
              // list's own entry) predate the delete — drop them so the
              // grid we land on can't flash the deleted list (issue #154).
              dropCached("/lists");
              dropCached(`/lists/${id}`);
              navigate("/lists");
            }}
          >
            <IconTrash size={15} /> Delete list
          </button>
        </div>
      </div>

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

      {!!data.list.comments_enabled && !!data.list.is_shared && (
        <section className="list-comments">
          <h2 className="section-title">Comments</h2>
          <Comments targetType="list" targetId={data.list.id} />
        </section>
      )}
      {!!data.list.comments_enabled && !data.list.is_shared && (
        <p className="settings-hint list-comments-note">
          Comments are on, but they only appear once this list is public.
        </p>
      )}
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
