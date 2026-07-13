import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { del, put } from "../api";
import { useAuth } from "../app";
import {
  TasteGraph,
  tasteMediaKey,
  type TasteGraphMedia,
  type TasteGraphPayload,
  type TasteMediaType,
  type TasteSelection,
} from "../components/taste-graph";
import { ErrorBoundary } from "../components/error-boundary";
import { IconHeart, IconHeartOutline, IconList, IconShare, IconUsers, IconWarning } from "../components/icons";
import { RowListSkeleton } from "../components/skeleton";
import { Empty, ErrorNote } from "../components/ui";
import { useApi, useDocumentTitle } from "../hooks";
import { poster } from "../img";
import { mediaPath } from "../paths";

type ViewMode = "graph" | "list";

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function FavoriteMarks({ item }: { item: TasteGraphMedia }) {
  return (
    <span className="taste-favorite-marks">
      {item.myFavorite && (
        <span className="taste-favorite-mark is-mine" title="Your favorite">
          <IconHeart size={12} /> You
        </span>
      )}
      {item.mutualFavoriteCount > 0 && (
        <span className="taste-favorite-mark" title={`${item.mutualFavoriteCount} mutual favorites`}>
          <IconHeart size={12} /> {item.mutualFavoriteCount}
        </span>
      )}
    </span>
  );
}

export function SharedSignalPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi<TasteGraphPayload>("/social/taste-graph");
  const webglSupported = useMemo(supportsWebGL, []);
  const [view, setView] = useState<ViewMode>(() => (webglSupported ? "graph" : "list"));
  // Once the WebGL layer fails on this device we stop offering the graph and
  // stay on the list, so a crashing GPU can't strand anyone on a black canvas.
  const [graphBroken, setGraphBroken] = useState(false);
  const [selected, setSelected] = useState<TasteSelection>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  useDocumentTitle("Shared Signal");

  const effectiveView: ViewMode = graphBroken ? "list" : view;

  const handleGraphError = useCallback(() => {
    setGraphBroken(true);
    setView("list");
    setSelected(null);
  }, []);

  // Every mutual is always in play — comparing against one at a time was more
  // chrome than it earned, so the whole shared signal shows at once.
  const media = useMemo(
    () =>
      (data?.media ?? []).map((item) => {
        const override = favoriteOverrides.get(tasteMediaKey(item.type, item.id));
        const myFavorite = override ?? item.myFavorite;
        return {
          ...item,
          myFavorite,
          mutualFavorite: myFavorite && item.mutualFavoriteCount > 0,
        };
      }),
    [data?.media, favoriteOverrides]
  );

  const links = useMemo(() => data?.links ?? [], [data?.links]);
  const mediaKeys = useMemo(() => new Set(media.map((item) => tasteMediaKey(item.type, item.id))), [media]);

  // The list is ranked by how many mutuals you share each title with, so the
  // most-shared titles sit at the top.
  const listMedia = useMemo(
    () =>
      [...media].sort(
        (a, b) => b.mutualViewerCount - a.mutualViewerCount || a.title.localeCompare(b.title)
      ),
    [media]
  );

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "media" && !mediaKeys.has(tasteMediaKey(selected.type, selected.id))) setSelected(null);
    if (selected.kind === "person" && !links.some((link) => link.person === selected.username)) setSelected(null);
  }, [selected, links, mediaKeys]);

  useEffect(() => {
    setFavoriteError(null);
  }, [selected]);

  const selectedMedia =
    selected?.kind === "media"
      ? media.find((item) => item.type === selected.type && item.id === selected.id) ?? null
      : null;
  const selectedPerson = selected?.kind === "person" ? selected.username : null;
  const mutualCount = new Set(links.map((link) => link.person)).size;

  const toggleFavorite = async (item: TasteGraphMedia) => {
    const key = tasteMediaKey(item.type, item.id);
    const next = !item.myFavorite;
    const collection = item.type === "show" ? "shows" : "movies";
    setFavoriteBusy(key);
    setFavoriteError(null);
    setFavoriteOverrides((current) => new Map(current).set(key, next));
    try {
      if (next) await put(`/${collection}/${item.id}/favorite`);
      else await del(`/${collection}/${item.id}/favorite`);
      reload();
    } catch (e) {
      setFavoriteOverrides((current) => new Map(current).set(key, item.myFavorite));
      setFavoriteError(e instanceof Error ? e.message : "Couldn't update that favorite");
    } finally {
      setFavoriteBusy(null);
    }
  };

  if (loading)
    return (
      <div>
        <Link className="crumb" to="/following">← Following</Link>
        <h1 className="page-title">Shared Signal</h1>
        <RowListSkeleton count={6} />
      </div>
    );
  if (error) return <ErrorNote message={error} />;
  if (!data || !user) return null;

  if (!data.summary.mutualCount)
    return (
      <div>
        <Link className="crumb" to="/following">← Following</Link>
        <h1 className="page-title">Shared Signal</h1>
        <Empty title="No mutuals yet" hint="Follow each other first, then your shared watch histories land here." />
        <Link to="/following" className="btn btn-ghost taste-empty-action">
          <IconUsers size={15} /> Find people
        </Link>
      </div>
    );

  return (
    <div className="taste-page">
      <Link className="crumb" to="/following">← Following</Link>
      <div className="taste-page-head">
        <div>
          <h1 className="page-title">Shared Signal</h1>
          <p>Movies, TV shows, and anime in both your watch histories.</p>
        </div>
        <p className="mono taste-summary" aria-live="polite">
          {media.length} {media.length === 1 ? "title" : "titles"} · {mutualCount} {mutualCount === 1 ? "mutual" : "mutuals"}
        </p>
      </div>

      {data.summary.truncated && (
        <p className="taste-limit-note">
          Showing your {data.summary.mutualsShown} most recent mutuals out of {data.summary.mutualCount}.
        </p>
      )}

      {!media.length ? (
        <Empty title="No shared titles yet" hint="Your watch histories haven't crossed yet." />
      ) : (
        <>
          <div className="taste-toolbar" aria-label="Shared title controls">
            <p className="mono taste-toolbar-hint">
              {effectiveView === "graph" ? "Drag to pan · scroll to zoom" : "Ranked by most shared"}
            </p>
            <div className="taste-view-switch" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={effectiveView === "graph"}
                disabled={!webglSupported || graphBroken}
                title={webglSupported ? "Show graph" : "Graph view needs WebGL"}
                onClick={() => setView("graph")}
              >
                <IconShare size={14} /> Graph
              </button>
              <button type="button" aria-pressed={effectiveView === "list"} onClick={() => setView("list")}>
                <IconList size={14} /> List
              </button>
            </div>
          </div>

          {graphBroken && (
            <p className="taste-limit-note">The live graph hit a snag on this device — showing the list instead.</p>
          )}

          <div className={`taste-workspace taste-workspace--${effectiveView}`}>
            <main className="taste-visual">
              {effectiveView === "graph" ? (
                <ErrorBoundary
                  onError={handleGraphError}
                  fallback={() => (
                    <div className="taste-graph-fallback">
                      <IconWarning size={24} />
                      <p>The live graph hit a snag. Switching to the list.</p>
                    </div>
                  )}
                >
                  <TasteGraph
                    media={media}
                    links={links}
                    selfUsername={user.username}
                    selected={selected}
                    onSelect={setSelected}
                    onRenderError={handleGraphError}
                  />
                </ErrorBoundary>
              ) : (
                <ul className="taste-list" aria-label="Shared titles">
                  {listMedia.map((item) => {
                    const image = poster(item.poster, "w154");
                    const key = tasteMediaKey(item.type, item.id);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={
                            selectedMedia?.type === item.type && selectedMedia.id === item.id ? "is-selected" : ""
                          }
                          onClick={() => setSelected({ kind: "media", type: item.type, id: item.id })}
                        >
                          {image ? (
                            <img className={`is-${item.category}`} src={image} alt="" loading="lazy" />
                          ) : (
                            <span className={`taste-list-poster-fallback is-${item.category}`}>
                              <IconShare size={18} />
                            </span>
                          )}
                          <span className="taste-list-copy">
                            <strong>{item.title}</strong>
                            <span className="mono taste-list-meta">Shared with {item.mutualViewerCount}</span>
                            <FavoriteMarks item={item} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </main>

            <aside className="taste-detail" aria-live="polite">
              {selectedMedia ? (
                <MediaDetail
                  item={selectedMedia}
                  links={links}
                  busy={favoriteBusy === tasteMediaKey(selectedMedia.type, selectedMedia.id)}
                  error={favoriteError}
                  onToggleFavorite={() => void toggleFavorite(selectedMedia)}
                  onSelectPerson={(username) => setSelected({ kind: "person", username })}
                />
              ) : selectedPerson ? (
                <PersonDetail
                  username={selectedPerson}
                  media={media.filter((item) =>
                    links.some(
                      (link) =>
                        link.person === selectedPerson && link.targetType === item.type && link.targetId === item.id
                    )
                  )}
                  favoriteMediaKeys={new Set(
                    links
                      .filter((link) => link.person === selectedPerson && link.favorite)
                      .map((link) => tasteMediaKey(link.targetType, link.targetId))
                  )}
                  onSelectMedia={(type, id) => setSelected({ kind: "media", type, id })}
                />
              ) : (
                <GraphKey />
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function MediaDetail({
  item,
  links,
  busy,
  error,
  onToggleFavorite,
  onSelectPerson,
}: {
  item: TasteGraphMedia;
  links: TasteGraphPayload["links"];
  busy: boolean;
  error: string | null;
  onToggleFavorite: () => void;
  onSelectPerson: (username: string) => void;
}) {
  const image = poster(item.poster, "w342");
  const viewers = links
    .filter((link) => link.targetType === item.type && link.targetId === item.id)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.person.localeCompare(b.person));
  const isMutualFavorite = item.myFavorite && viewers.some((viewer) => viewer.favorite);

  return (
    <>
      {image && (
        <img className={`taste-detail-poster is-${item.category}`} src={image} alt={`Poster for ${item.title}`} />
      )}
      <p className="mono taste-detail-kicker">
        Shared with {viewers.length} {viewers.length === 1 ? "mutual" : "mutuals"}
      </p>
      <h2>{item.title}</h2>
      {isMutualFavorite && <p className="taste-mutual-favorite"><IconHeart size={13} /> Mutual favorite</p>}
      <button
        type="button"
        className={`btn btn-ghost taste-favorite-action${item.myFavorite ? " is-on" : ""}`}
        aria-pressed={item.myFavorite}
        disabled={busy}
        onClick={onToggleFavorite}
      >
        {item.myFavorite ? <IconHeart size={15} /> : <IconHeartOutline size={15} />}
        {item.myFavorite ? "Favorited" : "Add to favorites"}
      </button>
      {error && <ErrorNote message={error} />}

      <h3>Shared with</h3>
      <ul className="taste-viewers">
        {viewers.map((viewer) => (
          <li key={viewer.person}>
            <button type="button" onClick={() => onSelectPerson(viewer.person)}>
              <span>{viewer.person}</span>
              {viewer.favorite && <span className="taste-viewer-favorite"><IconHeart size={12} /> favorite</span>}
            </button>
          </li>
        ))}
      </ul>
      <Link className="btn btn-ghost taste-detail-link" to={mediaPath(item.type, item.id, item.title)}>
        View {item.type === "show" ? "show" : "movie"}
      </Link>
    </>
  );
}

function PersonDetail({
  username,
  media,
  favoriteMediaKeys,
  onSelectMedia,
}: {
  username: string;
  media: TasteGraphMedia[];
  favoriteMediaKeys: ReadonlySet<string>;
  onSelectMedia: (type: TasteMediaType, id: number) => void;
}) {
  return (
    <>
      <p className="mono taste-detail-kicker">MUTUAL</p>
      <h2>{username}</h2>
      <p>
        You share {media.length} {media.length === 1 ? "title" : "titles"} in this signal.
      </p>
      <div className="taste-detail-actions">
        <Link className="btn btn-ghost" to={`/u/${username}`}>Profile</Link>
      </div>
      <h3>Shared titles</h3>
      <ul className="taste-person-movies">
        {media.slice(0, 12).map((item) => {
          const key = tasteMediaKey(item.type, item.id);
          return (
            <li key={key}>
              <button type="button" onClick={() => onSelectMedia(item.type, item.id)}>
                <span>{item.title}</span>
                {item.myFavorite && favoriteMediaKeys.has(key) && <IconHeart size={12} />}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function GraphKey() {
  return (
    <>
      <p className="mono taste-detail-kicker">PATCH BAY</p>
      <h2>Read the signal</h2>
      <p>Select a title or mutual to isolate their connections.</p>
      <ul className="taste-key">
        <li><span className="taste-key-dot is-you" /> You</li>
        <li><span className="taste-key-dot is-mutual" /> Mutual</li>
        <li><span className="taste-key-frame is-movie" /> Movie</li>
        <li><span className="taste-key-frame is-show" /> TV show</li>
        <li><span className="taste-key-frame is-anime" /> Anime</li>
        <li><span className="taste-key-line is-favorite" /> Favorited by that person</li>
      </ul>
      <p className="taste-detail-hint">
        Two red connections meeting at a title mark a mutual favorite. Drag to pan, then scroll or pinch to zoom.
      </p>
    </>
  );
}
