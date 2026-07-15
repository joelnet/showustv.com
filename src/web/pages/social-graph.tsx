import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app";
import {
  TasteGraph,
  tasteMediaKey,
  type TasteGraphMedia,
  type TasteGraphPayload,
  type TasteSelection,
} from "../components/taste-graph";
import { ErrorBoundary } from "../components/error-boundary";
import { IconHeart, IconList, IconShare, IconWarning } from "../components/icons";
import { RowListSkeleton } from "../components/skeleton";
import { Empty, ErrorNote } from "../components/ui";
import { useApi } from "../hooks";
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

// The social-graph section (taste graph + list) renders inline on the Following
// page (issue #284) rather than on its own route. It owns its /social/taste-graph
// fetch and every loading/empty/error state so the Following page can drop it in
// as one self-contained section right after the follow form.
export function SocialGraphSection() {
  const { user } = useAuth();
  const { data, loading, error } = useApi<TasteGraphPayload>("/social/taste-graph");
  const webglSupported = useMemo(supportsWebGL, []);
  const [view, setView] = useState<ViewMode>(() => (webglSupported ? "graph" : "list"));
  // Once the WebGL layer fails on this device we stop offering the graph and
  // stay on the list, so a crashing GPU can't strand anyone on a black canvas.
  const [graphBroken, setGraphBroken] = useState(false);
  // Drives the graph's click-to-isolate highlight only; there is no detail panel.
  const [selected, setSelected] = useState<TasteSelection>(null);

  const effectiveView: ViewMode = graphBroken ? "list" : view;

  const handleGraphError = useCallback(() => {
    setGraphBroken(true);
    setView("list");
    setSelected(null);
  }, []);

  const media = useMemo(() => data?.media ?? [], [data?.media]);
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

  // The mutuals sharing each title, alphabetised — the list spells the names
  // out instead of showing a bare count.
  const viewersByMedia = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of links) {
      const key = tasteMediaKey(link.targetType, link.targetId);
      const names = map.get(key);
      if (names) names.push(link.person);
      else map.set(key, [link.person]);
    }
    for (const names of map.values()) names.sort((a, b) => a.localeCompare(b));
    return map;
  }, [links]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "media" && !mediaKeys.has(tasteMediaKey(selected.type, selected.id))) setSelected(null);
    if (selected.kind === "person" && !links.some((link) => link.person === selected.username)) setSelected(null);
  }, [selected, links, mediaKeys]);

  const mutualCount = new Set(links.map((link) => link.person)).size;

  if (loading)
    return (
      <section>
        <h2 className="section-title">Social Graph</h2>
        <RowListSkeleton count={4} />
      </section>
    );
  if (error)
    return (
      <section>
        <h2 className="section-title">Social Graph</h2>
        <ErrorNote message={error} />
      </section>
    );
  if (!data || !user) return null;

  if (!data.summary.mutualCount)
    return (
      <section>
        <h2 className="section-title">Social Graph</h2>
        <Empty title="No social graph yet" hint="Follow each other first, then your shared watch histories land here." />
      </section>
    );

  return (
    <section>
      <h2 className="section-title">Social Graph</h2>
      <div className="taste-page-head">
        <p>Movies, TV shows, and anime in both your watch histories.</p>
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
                const sharedWith = viewersByMedia.get(key) ?? [];
                return (
                  <li key={key}>
                    <Link to={mediaPath(item.type, item.id, item.title)}>
                      {image ? (
                        <img className={`is-${item.category}`} src={image} alt="" loading="lazy" />
                      ) : (
                        <span className={`taste-list-poster-fallback is-${item.category}`}>
                          <IconShare size={18} />
                        </span>
                      )}
                      <span className="taste-list-copy">
                        <strong>{item.title}</strong>
                        {sharedWith.length > 0 && (
                          <span className="taste-list-shared">Shared with {sharedWith.join(", ")}</span>
                        )}
                        <FavoriteMarks item={item} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
