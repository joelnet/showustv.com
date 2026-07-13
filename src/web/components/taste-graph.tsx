import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import { createNodeImageProgram } from "@sigma/node-image";
import { poster } from "../img";

export interface TasteGraphMovie {
  id: number;
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
  movie: number;
  favorite: boolean;
}

export interface TasteGraphPayload {
  summary: {
    mutualCount: number;
    mutualsShown: number;
    sharedMovieCount: number;
    mutualFavoriteMovieCount: number;
    truncated: boolean;
  };
  mutuals: { username: string }[];
  movies: TasteGraphMovie[];
  links: TasteGraphLink[];
}

export type TasteSelection =
  | { kind: "movie"; id: number }
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
  kind: "movie" | "person";
  entityId: string | number;
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
  movies: TasteGraphMovie[];
  links: TasteGraphLink[];
  selfUsername: string;
  selected: TasteSelection;
  onSelect: (selection: TasteSelection) => void;
}

const SELF_NODE = "person:self";
const MovieImageProgram = createNodeImageProgram<TasteNodeAttributes, TasteEdgeAttributes>({
  objectFit: "cover",
  keepWithinCircle: false,
  size: { mode: "max", value: 192 },
});

const personNode = (username: string) => `person:${username}`;
const movieNode = (id: number) => `movie:${id}`;

// Stable, small positional jitter prevents stacked movie nodes without making
// the layout change every time the page mounts.
function jitter(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff - 0.5) * 2.4;
}

export function TasteGraph({ movies, links, selfUsername, selected, onSelect }: TasteGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const graphRef = useRef<Graph<TasteNodeAttributes, TasteEdgeAttributes> | null>(null);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !movies.length) return;

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
      zIndex: 3,
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
        zIndex: 2,
      });
    });

    const linksByMovie = new Map<number, TasteGraphLink[]>();
    for (const link of links) {
      const group = linksByMovie.get(link.movie) ?? [];
      group.push(link);
      linksByMovie.set(link.movie, group);
    }

    for (const movie of movies) {
      const movieLinks = linksByMovie.get(movie.id) ?? [];
      const center = movieLinks.reduce(
        (sum, link) => {
          const point = positions.get(link.person);
          return point ? { x: sum.x + point.x, y: sum.y + point.y } : sum;
        },
        { x: 0, y: 0 }
      );
      const divisor = movieLinks.length + 1; // self is fixed at 0,0
      const image = poster(movie.poster, "w154");
      graph.addNode(movieNode(movie.id), {
        x: center.x / divisor + jitter(`x:${movie.id}`),
        y: center.y / divisor + jitter(`y:${movie.id}`),
        size: Math.min(11, 5.5 + Math.sqrt(movie.mutualViewerCount) * 1.4),
        label: movie.title,
        color: movie.myFavorite ? "#ff4d3d" : "#202836",
        type: image ? "image" : "circle",
        image: image ?? undefined,
        kind: "movie",
        entityId: movie.id,
        zIndex: movie.myFavorite ? 2 : 1,
      });
      graph.addEdgeWithKey(`self:${movie.id}`, SELF_NODE, movieNode(movie.id), {
        size: 0.45,
        color: "#2a3344",
        favorite: movie.myFavorite,
      });
    }

    for (const link of links) {
      if (!graph.hasNode(personNode(link.person)) || !graph.hasNode(movieNode(link.movie))) continue;
      graph.addEdgeWithKey(`${link.person}:${link.movie}`, personNode(link.person), movieNode(link.movie), {
        size: 0.45,
        color: "#2a3344",
        favorite: link.favorite,
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
      nodeProgramClasses: { image: MovieImageProgram },
      defaultNodeColor: "#202836",
      defaultEdgeColor: "#2a3344",
      labelColor: { color: "#ede9e0" },
      labelFont: "Lato, system-ui, sans-serif",
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
        attributes.kind === "movie"
          ? { kind: "movie", id: Number(attributes.entityId) }
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
  }, [movies, links, selfUsername]);

  useEffect(() => {
    const renderer = rendererRef.current;
    const graph = graphRef.current;
    if (!renderer || !graph) return;

    const selectedNode =
      selected?.kind === "movie"
        ? movieNode(selected.id)
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
          color: attributes.favorite ? "#ff4d3d" : "#56cfde",
          size: attributes.favorite ? 2 : 1.4,
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
        aria-label="Interactive graph of movies shared with mutuals. Use the list view for keyboard navigation."
      />
      <button type="button" className="taste-reset btn btn-ghost" onClick={resetView}>
        Reset view
      </button>
    </div>
  );
}
