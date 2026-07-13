import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { del, put } from "../api";
import { useAuth } from "../app";
import {
  TasteGraph,
  tasteMediaKey,
  type TasteGraphMedia,
  type TasteGraphPayload,
  type TasteMediaCategory,
  type TasteMediaType,
  type TasteSelection,
} from "../components/taste-graph";
import { IconHeart, IconHeartOutline, IconList, IconShare, IconUsers } from "../components/icons";
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

function mediaLabel(item: Pick<TasteGraphMedia, "type" | "category">): string {
  if (item.category === "anime") return item.type === "show" ? "Anime series" : "Anime movie";
  return item.category === "show" ? "TV show" : "Movie";
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
  const [mutualFilter, setMutualFilter] = useState("all");
  const webglSupported = useMemo(supportsWebGL, []);
  const [view, setView] = useState<ViewMode>(() => (webglSupported ? "graph" : "list"));
  const [selected, setSelected] = useState<TasteSelection>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  useDocumentTitle("Shared Signal");

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

  const visibleMedia = useMemo(() => {
    if (!data || mutualFilter === "all") return media;
    const mutualMediaKeys = new Set(
      data.links
        .filter((link) => link.person === mutualFilter)
        .map((link) => tasteMediaKey(link.targetType, link.targetId))
    );
    return media.filter((item) => mutualMediaKeys.has(tasteMediaKey(item.type, item.id)));
  }, [data, media, mutualFilter]);

  const visibleMediaKeys = useMemo(
    () => new Set(visibleMedia.map((item) => tasteMediaKey(item.type, item.id))),
    [visibleMedia]
  );

  const visibleLinks = useMemo(() => {
    if (!data) return [];
    return data.links.filter(
      (link) =>
        visibleMediaKeys.has(tasteMediaKey(link.targetType, link.targetId)) &&
        (mutualFilter === "all" || link.person === mutualFilter)
    );
  }, [data, mutualFilter, visibleMediaKeys]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "media" && !visibleMediaKeys.has(tasteMediaKey(selected.type, selected.id))) setSelected(null);
    if (selected.kind === "person" && !visibleLinks.some((link) => link.person === selected.username)) setSelected(null);
  }, [selected, visibleLinks, visibleMediaKeys]);

  useEffect(() => {
    setFavoriteError(null);
  }, [selected]);

  const selectedMedia =
    selected?.kind === "media"
      ? media.find((item) => item.type === selected.type && item.id === selected.id) ?? null
      : null;
  const selectedPerson = selected?.kind === "person" ? selected.username : null;
  const visibleMutualCount = new Set(visibleLinks.map((link) => link.person)).size;
  const categoryCounts = useMemo(
    () =>
      visibleMedia.reduce<Record<TasteMediaCategory, number>>(
        (counts, item) => ({ ...counts, [item.category]: counts[item.category] + 1 }),
        { movie: 0, show: 0, anime: 0 }
      ),
    [visibleMedia]
  );

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
          {visibleMedia.length} titles · {categoryCounts.movie} movies · {categoryCounts.show} TV · {categoryCounts.anime} anime ·{" "}
          {visibleMutualCount} {visibleMutualCount === 1 ? "mutual" : "mutuals"}
        </p>
      </div>

      {data.summary.truncated && (
        <p className="taste-limit-note">
          Showing your {data.summary.mutualsShown} most recent mutuals out of {data.summary.mutualCount}.
        </p>
      )}

      {!data.media.length ? (
        <Empty title="No shared titles yet" hint="Your watch histories haven't crossed yet." />
      ) : (
        <>
          <div className="taste-toolbar" aria-label="Shared title controls">
            <label className="taste-mutual-select">
              <span>Compare</span>
              <select value={mutualFilter} onChange={(event) => setMutualFilter(event.target.value)}>
                <option value="all">All mutuals</option>
                {data.mutuals.map((mutual) => (
                  <option key={mutual.username} value={mutual.username}>
                    {mutual.username}
                  </option>
                ))}
              </select>
            </label>

            <div className="taste-view-switch" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={view === "graph"}
                disabled={!webglSupported}
                title={webglSupported ? "Show graph" : "Graph view needs WebGL"}
                onClick={() => setView("graph")}
              >
                <IconShare size={14} /> Graph
              </button>
              <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
                <IconList size={14} /> List
              </button>
            </div>
          </div>

          {!visibleMedia.length ? (
            <Empty title="Nothing on this channel" hint="Compare everyone again to bring the full signal back." />
          ) : (
            <div className={`taste-workspace taste-workspace--${view}`}>
              <main className="taste-visual">
                {view === "graph" ? (
                  <TasteGraph
                    media={visibleMedia}
                    links={visibleLinks}
                    selfUsername={user.username}
                    selected={selected}
                    onSelect={setSelected}
                  />
                ) : (
                  <ul className="taste-list" aria-label="Shared titles">
                    {visibleMedia.map((item) => {
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
                              <span className="mono taste-list-meta">
                                <span className={`taste-media-kind is-${item.category}`}>{mediaLabel(item)}</span>
                                <span>{item.releaseYear ?? "Year unknown"} · shared with {item.mutualViewerCount}</span>
                              </span>
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
                    links={visibleLinks}
                    busy={favoriteBusy === tasteMediaKey(selectedMedia.type, selectedMedia.id)}
                    error={favoriteError}
                    onToggleFavorite={() => void toggleFavorite(selectedMedia)}
                    onSelectPerson={(username) => setSelected({ kind: "person", username })}
                  />
                ) : selectedPerson ? (
                  <PersonDetail
                    username={selectedPerson}
                    media={visibleMedia.filter((item) =>
                      visibleLinks.some(
                        (link) =>
                          link.person === selectedPerson && link.targetType === item.type && link.targetId === item.id
                      )
                    )}
                    favoriteMediaKeys={new Set(
                      visibleLinks
                        .filter((link) => link.person === selectedPerson && link.favorite)
                        .map((link) => tasteMediaKey(link.targetType, link.targetId))
                    )}
                    onCompare={() => {
                      setMutualFilter(selectedPerson);
                      setSelected(null);
                    }}
                    onSelectMedia={(type, id) => setSelected({ kind: "media", type, id })}
                  />
                ) : (
                  <GraphKey />
                )}
              </aside>
            </div>
          )}
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
      <p className="mono taste-detail-kicker">{mediaLabel(item).toUpperCase()} · {item.releaseYear ?? "YEAR UNKNOWN"}</p>
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
  onCompare,
  onSelectMedia,
}: {
  username: string;
  media: TasteGraphMedia[];
  favoriteMediaKeys: ReadonlySet<string>;
  onCompare: () => void;
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
        <button type="button" className="btn" onClick={onCompare}>Compare only</button>
        <Link className="btn btn-ghost" to={`/u/${username}`}>Profile</Link>
      </div>
      <h3>Shared titles</h3>
      <ul className="taste-person-movies">
        {media.slice(0, 12).map((item) => {
          const key = tasteMediaKey(item.type, item.id);
          return (
            <li key={key}>
              <button type="button" onClick={() => onSelectMedia(item.type, item.id)}>
                <span><span className={`taste-mini-kind is-${item.category}`}>{mediaLabel(item)}</span>{item.title}</span>
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
