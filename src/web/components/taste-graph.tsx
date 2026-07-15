import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";

export type TasteMediaType = "movie" | "show";
export type TasteMediaCategory = "movie" | "show" | "anime";

export interface TasteGraphMedia {
  id: number;
  type: TasteMediaType;
  category: TasteMediaCategory;
  title: string;
  poster: string | null;
  releaseYear: number | null;
  mutualViewerCount: number;
  mutualFavoriteCount: number;
  myFavorite: boolean;
  mutualFavorite: boolean;
}

export interface TasteGraphLink {
  person: string;
  targetType: TasteMediaType;
  targetId: number;
  favorite: boolean;
}

export interface TasteGraphPayload {
  summary: {
    mutualCount: number;
    mutualsShown: number;
    sharedTitleCount: number;
    movieCount: number;
    showCount: number;
    animeCount: number;
    mutualFavoriteCount: number;
    truncated: boolean;
  };
  mutuals: { username: string }[];
  media: TasteGraphMedia[];
  links: TasteGraphLink[];
}

export type TasteSelection =
  | { kind: "media"; type: TasteMediaType; id: number }
  | { kind: "person"; username: string }
  | null;

interface TasteNodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  type: "circle";
  kind: "media" | "person";
  entityId: string | number;
  entityType?: TasteMediaType;
  forceLabel?: boolean;
  zIndex?: number;
}

interface TasteEdgeAttributes {
  size: number;
  color: string;
  favorite: boolean;
  zIndex?: number;
}

interface TasteGraphProps {
  media: TasteGraphMedia[];
  links: TasteGraphLink[];
  selfUsername: string;
  selected: TasteSelection;
  onSelect: (selection: TasteSelection) => void;
  // Fired when the WebGL layer dies (lost context, or a renderer that fails to
  // construct). The page uses it to fall back to the list view instead of
  // leaving a dead black canvas.
  onRenderError?: () => void;
}

const SELF_NODE = "person:self";
const FAVORITE_COLOR = "#ff4d3d";
const SELF_COLOR = "#ffae2e"; // tungsten amber — "you" are the console at the center
const PERSON_COLOR = "#56cfde";
// Brighter than --line so the patch cables actually read against the scope.
const EDGE_COLOR = "#3d4a60";
const CATEGORY_COLORS: Record<TasteMediaCategory, string> = {
  movie: "#a7b0c0",
  show: "#56cfde",
  anime: "#58c983",
};

// Nodes are plain dots — Obsidian-graph style — coloured by category. Posters
// were too small to read once several titles crowded the middle, so the visual
// language is dots + labels + cables, and favourite meaning lives entirely in
// the connections: a red line says that person favourited that title, and red
// lines from both sides form a mutual favourite.
export const tasteMediaKey = (type: TasteMediaType, id: number) => `${type}:${id}`;
const personNode = (username: string) => `person:${username}`;
const mediaNode = (type: TasteMediaType, id: number) => `media:${tasteMediaKey(type, id)}`;

// Stable, small positional jitter prevents stacked media nodes without making
// the layout change every time the page mounts.
function jitter(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff - 0.5) * 2.4;
}

export function TasteGraph({ media, links, selfUsername, selected, onSelect, onRenderError }: TasteGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const graphRef = useRef<Graph<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const onSelectRef = useRef(onSelect);
  const onRenderErrorRef = useRef(onRenderError);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onRenderErrorRef.current = onRenderError;
  }, [onRenderError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !media.length) return;

    const graph = new Graph<TasteNodeAttributes, TasteEdgeAttributes>({ type: "undirected" });
    const people = Array.from(new Set(links.map((link) => link.person))).sort((a, b) => a.localeCompare(b));
    const radius = Math.max(12, Math.sqrt(Math.max(people.length, 1)) * 6);
    const positions = new Map<string, { x: number; y: number }>();

    graph.addNode(SELF_NODE, {
      x: 0,
      y: 0,
      size: 11,
      label: `You · ${selfUsername}`,
      color: SELF_COLOR,
      type: "circle",
      kind: "person",
      entityId: selfUsername,
      forceLabel: true,
      zIndex: 4,
    });

    people.forEach((username, index) => {
      const angle = (index / people.length) * Math.PI * 2 - Math.PI / 2;
      const point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      positions.set(username, point);
      graph.addNode(personNode(username), {
        ...point,
        size: 7,
        label: username,
        color: PERSON_COLOR,
        type: "circle",
        kind: "person",
        entityId: username,
        // Labels are forced on for every node so titles/handles stay readable
        // at the default zoom — the recurring complaint was that you had to
        // zoom in close before anything was named.
        forceLabel: true,
        zIndex: 3,
      });
    });

    const linksByMedia = new Map<string, TasteGraphLink[]>();
    for (const link of links) {
      const key = tasteMediaKey(link.targetType, link.targetId);
      const group = linksByMedia.get(key) ?? [];
      group.push(link);
      linksByMedia.set(key, group);
    }

    for (const item of media) {
      const itemKey = tasteMediaKey(item.type, item.id);
      const itemLinks = linksByMedia.get(itemKey) ?? [];
      const center = itemLinks.reduce(
        (sum, link) => {
          const point = positions.get(link.person);
          return point ? { x: sum.x + point.x, y: sum.y + point.y } : sum;
        },
        { x: 0, y: 0 }
      );
      const divisor = itemLinks.length + 1; // self is fixed at 0,0
      const favoriteBoost = item.mutualFavorite ? 2.2 : item.myFavorite || item.mutualFavoriteCount > 0 ? 1 : 0;
      graph.addNode(mediaNode(item.type, item.id), {
        x: center.x / divisor + jitter(`x:${itemKey}`),
        y: center.y / divisor + jitter(`y:${itemKey}`),
        // Dots scale with how many mutuals share the title (degree), the way
        // an Obsidian node grows with its links.
        size: Math.min(14, 5 + Math.sqrt(item.mutualViewerCount) * 1.6 + favoriteBoost),
        label: item.title,
        color: CATEGORY_COLORS[item.category],
        type: "circle",
        kind: "media",
        entityId: item.id,
        entityType: item.type,
        forceLabel: true,
        zIndex: item.mutualFavorite ? 3 : item.myFavorite || item.mutualFavoriteCount > 0 ? 2 : 1,
      });
      graph.addEdgeWithKey(`self:${itemKey}`, SELF_NODE, mediaNode(item.type, item.id), {
        size: item.myFavorite ? 1.45 : 0.45,
        color: item.myFavorite ? FAVORITE_COLOR : EDGE_COLOR,
        favorite: item.myFavorite,
        zIndex: item.myFavorite ? 2 : 1,
      });
    }

    for (const link of links) {
      const target = mediaNode(link.targetType, link.targetId);
      if (!graph.hasNode(personNode(link.person)) || !graph.hasNode(target)) continue;
      graph.addEdgeWithKey(`${link.person}:${tasteMediaKey(link.targetType, link.targetId)}`, personNode(link.person), target, {
        size: link.favorite ? 1.45 : 0.45,
        color: link.favorite ? FAVORITE_COLOR : EDGE_COLOR,
        favorite: link.favorite,
        zIndex: link.favorite ? 2 : 1,
      });
    }

    if (graph.order > 2) {
      forceAtlas2.assign(graph, {
        iterations: graph.order > 140 ? 80 : 120,
        settings: {
          adjustSizes: false,
          barnesHutOptimize: graph.order > 100,
          gravity: 1.3,
          scalingRatio: 7,
          slowDown: 8,
        },
      });

      const self = graph.getNodeAttributes(SELF_NODE);
      graph.forEachNode((node, attributes) => {
        graph.mergeNodeAttributes(node, { x: attributes.x - self.x, y: attributes.y - self.y });
      });
    }

    let renderer: Sigma<TasteNodeAttributes, TasteEdgeAttributes>;
    try {
      renderer = new Sigma<TasteNodeAttributes, TasteEdgeAttributes>(graph, container, {
        defaultNodeColor: "#202836",
        defaultEdgeColor: EDGE_COLOR,
        labelColor: { color: "#ede9e0" },
        labelFont: "Lato, system-ui, sans-serif",
        labelSize: 11.5,
        labelWeight: "600",
        // With forceLabel on every node these density/threshold knobs only
        // affect hover labels, but keep them permissive as a safety net.
        labelDensity: 1,
        labelRenderedSizeThreshold: 0,
        stagePadding: 44,
        minCameraRatio: 0.25,
        maxCameraRatio: 5,
        hideEdgesOnMove: true,
        enableCameraRotation: false,
        zIndex: true,
      });
    } catch {
      // A device that can't spin up the WebGL layer must not leave a dead
      // canvas — bail to the list view instead.
      onRenderErrorRef.current?.();
      return;
    }

    // A lost GPU context (mobile backgrounding, driver reset) turns the canvas
    // permanently black. Catch it and hand the page back to the list view
    // rather than leaving a broken graph the user can only escape by
    // force-quitting the app.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      onRenderErrorRef.current?.();
    };
    const canvases = Array.from(container.querySelectorAll("canvas"));
    canvases.forEach((canvas) => canvas.addEventListener("webglcontextlost", onContextLost));

    renderer.on("clickNode", ({ node }) => {
      try {
        const attributes = graph.getNodeAttributes(node);
        onSelectRef.current(
          attributes.kind === "media" && attributes.entityType
            ? { kind: "media", type: attributes.entityType, id: Number(attributes.entityId) }
            : node === SELF_NODE
              ? null
              : { kind: "person", username: String(attributes.entityId) }
        );
      } catch {
        onSelectRef.current(null);
      }
    });
    renderer.on("clickStage", () => onSelectRef.current(null));

    graphRef.current = graph;
    rendererRef.current = renderer;
    return () => {
      canvases.forEach((canvas) => canvas.removeEventListener("webglcontextlost", onContextLost));
      renderer.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  }, [media, links, selfUsername]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;

    const selectedNode =
      selected?.kind === "media"
        ? mediaNode(selected.type, selected.id)
        : selected?.kind === "person"
          ? personNode(selected.username)
          : null;

    // Sigma's setSettings/refresh runs the reducers through the WebGL layer;
    // guard it so a bad frame downgrades to the list view instead of throwing
    // out of the render tree and blanking the app.
    try {
      if (!selectedNode || !graph.hasNode(selectedNode)) {
        renderer.setSettings({ nodeReducer: null, edgeReducer: null });
        renderer.refresh();
        return;
      }

      const neighborhood = new Set([selectedNode, ...graph.neighbors(selectedNode)]);
      if (selected?.kind === "person") neighborhood.add(SELF_NODE);
      renderer.setSettings({
        nodeReducer: (node, attributes) => {
          if (!neighborhood.has(node)) return { hidden: true };
          if (node === selectedNode)
            return {
              highlighted: true,
              forceLabel: true,
              size: attributes.size * 1.15,
              zIndex: 5,
            };
          return {
            forceLabel: true,
            zIndex: 3,
          };
        },
        edgeReducer: (edge, attributes) => {
          const source = graph.source(edge);
          const target = graph.target(edge);
          const selectedPersonComparison =
            selected?.kind === "person" &&
            ((source === SELF_NODE && neighborhood.has(target)) || (target === SELF_NODE && neighborhood.has(source)));
          if (source !== selectedNode && target !== selectedNode && !selectedPersonComparison) return { hidden: true };
          return {
            color: attributes.favorite ? FAVORITE_COLOR : PERSON_COLOR,
            size: attributes.favorite ? 2.2 : 1.4,
            zIndex: 4,
          };
        },
      });
      renderer.refresh();
    } catch {
      onRenderErrorRef.current?.();
    }
  }, [selected]);

  const resetView = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) renderer.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 });
    else void renderer.getCamera().animatedReset({ duration: 200 });
    onSelect(null);
  };

  return (
    <div className="taste-graph-wrap">
      <div
        ref={containerRef}
        className="taste-graph-canvas"
        role="region"
        aria-label="Interactive graph of movies, TV shows, and anime shared with mutuals. Red connections mark favorites. Use the list view for keyboard navigation."
      />
      <button type="button" className="taste-reset btn btn-ghost" onClick={resetView}>
        Reset view
      </button>
    </div>
  );
}
