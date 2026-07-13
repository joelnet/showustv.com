import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import { createNodeImageProgram } from "@sigma/node-image";
import { poster } from "../img";

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
  type: "circle" | "image";
  image?: string;
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
}

const SELF_NODE = "person:self";
const FAVORITE_COLOR = "#ff4d3d";
const EDGE_COLOR = "#2a3344";
const CATEGORY_COLORS: Record<TasteMediaCategory, string> = {
  movie: "#8e97a8",
  show: "#56cfde",
  anime: "#58c983",
};

// The padding leaves a narrow, category-colored frame around every poster.
// Favorite meaning belongs to the connections: a red line says that person
// favorited that title, and red lines from both sides form a mutual favorite.
const MediaImageProgram = createNodeImageProgram<TasteNodeAttributes, TasteEdgeAttributes>({
  objectFit: "cover",
  keepWithinCircle: false,
  padding: 0.08,
  size: { mode: "max", value: 192 },
});

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

export function TasteGraph({ media, links, selfUsername, selected, onSelect }: TasteGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const graphRef = useRef<Graph<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

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
      size: 10,
      label: `You · ${selfUsername}`,
      color: "#ede9e0",
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
        color: "#56cfde",
        type: "circle",
        kind: "person",
        entityId: username,
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
      const image = poster(item.poster, "w154");
      const favoriteBoost = item.mutualFavorite ? 1.8 : item.myFavorite || item.mutualFavoriteCount > 0 ? 0.8 : 0;
      graph.addNode(mediaNode(item.type, item.id), {
        x: center.x / divisor + jitter(`x:${itemKey}`),
        y: center.y / divisor + jitter(`y:${itemKey}`),
        size: Math.min(12.5, 5.7 + Math.sqrt(item.mutualViewerCount) * 1.25 + favoriteBoost),
        label: item.title,
        color: CATEGORY_COLORS[item.category],
        type: image ? "image" : "circle",
        image: image ?? undefined,
        kind: "media",
        entityId: item.id,
        entityType: item.type,
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

    const renderer = new Sigma<TasteNodeAttributes, TasteEdgeAttributes>(graph, container, {
      nodeProgramClasses: { image: MediaImageProgram },
      defaultNodeColor: "#202836",
      defaultEdgeColor: EDGE_COLOR,
      labelColor: { color: "#ede9e0" },
      labelFont: "Roboto, system-ui, sans-serif",
      labelSize: 12,
      labelWeight: "600",
      labelDensity: 0.08,
      labelRenderedSizeThreshold: 7,
      stagePadding: 36,
      minCameraRatio: 0.25,
      maxCameraRatio: 5,
      hideEdgesOnMove: true,
      enableCameraRotation: false,
      zIndex: true,
    });

    renderer.on("clickNode", ({ node }) => {
      const attributes = graph.getNodeAttributes(node);
      onSelectRef.current(
        attributes.kind === "media" && attributes.entityType
          ? { kind: "media", type: attributes.entityType, id: Number(attributes.entityId) }
          : node === SELF_NODE
            ? null
            : { kind: "person", username: String(attributes.entityId) }
      );
    });
    renderer.on("clickStage", () => onSelectRef.current(null));

    graphRef.current = graph;
    rendererRef.current = renderer;
    return () => {
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
          forceLabel: attributes.kind === "person",
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
          color: attributes.favorite ? FAVORITE_COLOR : "#56cfde",
          size: attributes.favorite ? 2.2 : 1.4,
          zIndex: 4,
        };
      },
    });
    renderer.refresh();
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
