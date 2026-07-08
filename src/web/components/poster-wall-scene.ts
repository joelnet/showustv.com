// The poster wall's three.js scene — everything heavy lives here so Vite
// splits it (plus the poster atlas) into a lazy chunk that only the logged-out
// landing route loads, after idle (see poster-wall.tsx).
//
// The wall is the inside of a big cylinder: four open-ended CylinderGeometry
// bands. All the poster art ships as ONE pre-composited atlas (4 rows stacked
// vertically — a single network round trip) that's sliced into a texture per
// row here, each with RepeatWrapping, scrolled by animating texture.offset.x —
// 4 draw calls, no lights, no postprocessing. Rows 1 & 3 drift opposite
// rows 2 & 4.
import * as THREE from "three";
import wallUrl from "../assets/poster-wall/wall.webp";

const ROWS = 4;
const PER_ROW = 16; // posters per row (matches scripts/generate-poster-wall.mjs)
const TILE_ASPECT = 160 / 231; // strip tile w/h, gutter included

const R = 10; // cylinder radius
const CAM_BACK = 0.18 * R; // camera pulled off-axis — the concavity dial (0 = flat-looking)
const FOV_Y = 38;
const OVERSCAN = 1.25; // arc wider than the frustum so edges never peek
const MAX_THETA = 2.4; // ultrawide cap keeps the curve subtle
// Scroll speeds in strip-widths/sec: rows 1 & 3 one way, 2 & 4 the other,
// slightly different magnitudes for a loose parallax feel (~25s per poster).
const SPEEDS = [0.045, -0.032, 0.05, -0.036].map((s) => s / PER_ROW);
// Initial offsets so the rows' poster columns don't line up.
const STAGGER = [0, 0.23, 0.41, 0.67];

export interface PosterWallHandle {
  dispose(): void;
}

const NOOP: PosterWallHandle = { dispose() {} };

export function mountPosterWall(container: HTMLElement, opts: { onReady: () => void }): PosterWallHandle {
  // three r163+ requires WebGL2; without it the hero keeps its plain backdrop.
  if (!document.createElement("canvas").getContext("webgl2")) return NOOP;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return NOOP;
  }
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_Y, 1, 0.1, 50);
  camera.position.set(0, 0, CAM_BACK);
  camera.lookAt(0, 0, -R);

  const meshes: THREE.Mesh[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  let textures: THREE.Texture[] = [];
  let raf = 0;
  let disposed = false;
  let visible = true; // IntersectionObserver state
  let hidden = document.hidden;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const clock = new THREE.Clock();

  // --- geometry ---------------------------------------------------------------
  // The wall fills the frustum at the arc's center distance, plus a little
  // spare; 4 rows with a 5% slate gap between bands (the page bg shows through
  // the transparent canvas).
  function arcTheta(aspect: number): number {
    const phi = Math.atan(Math.tan((FOV_Y * Math.PI) / 360) * aspect);
    return Math.min(2 * phi * OVERSCAN, MAX_THETA);
  }

  function buildMeshes(aspect: number): void {
    if (materials.length < 4) return; // textures not loaded yet
    for (const m of meshes) {
      scene.remove(m);
      m.geometry.dispose();
    }
    meshes.length = 0;

    const dist = R + CAM_BACK;
    const visH = 2 * dist * Math.tan((FOV_Y * Math.PI) / 360);
    const rowH = (visH * 1.05) / 4;
    const bandH = rowH * 0.95;
    const tileW = bandH * TILE_ASPECT;
    const theta = arcTheta(aspect);
    const thetaStart = Math.PI - theta / 2; // arc centered on -Z

    for (let i = 0; i < 4; i++) {
      const geo = new THREE.CylinderGeometry(R, R, bandH, 64, 1, true, thetaStart, theta);
      // Inside-a-panorama trick: flips winding so the default FrontSide faces
      // the camera AND un-mirrors the texture (poster titles stay readable).
      geo.scale(-1, 1, 1);
      const tex = textures[i];
      if (tex) tex.repeat.x = (R * theta) / tileW / PER_ROW;
      const mesh = new THREE.Mesh(geo, materials[i]);
      mesh.position.y = (1.5 - i) * rowH;
      scene.add(mesh);
      meshes.push(mesh);
    }
  }

  // --- render loop --------------------------------------------------------------
  function renderFrame(): void {
    renderer.render(scene, camera);
  }

  function tick(): void {
    raf = 0;
    if (disposed || hidden || !visible || reduceMotion.matches) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    textures.forEach((tex, i) => {
      tex.offset.x += SPEEDS[i] * dt;
    });
    renderFrame();
    raf = requestAnimationFrame(tick);
  }

  function wake(): void {
    if (disposed || raf || textures.length === 0) return;
    if (hidden || !visible) return;
    clock.getDelta(); // swallow the pause so the wall doesn't jump
    if (reduceMotion.matches) {
      renderFrame(); // static frame; no loop
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function sleep(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // --- sizing -------------------------------------------------------------------
  function resize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, w < 720 ? 1.5 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    buildMeshes(camera.aspect);
    if (textures.length) renderFrame();
  }

  // --- lifecycle wiring -----------------------------------------------------------
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? wake() : sleep();
  });
  io.observe(container);

  const onVisibility = () => {
    hidden = document.hidden;
    hidden ? sleep() : wake();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const onMotionChange = () => {
    sleep();
    wake();
  };
  reduceMotion.addEventListener("change", onMotionChange);

  const onContextLost = (e: Event) => {
    e.preventDefault();
    sleep();
    container.classList.remove("poster-wall--on"); // fade back to the plain backdrop
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);

  // --- textures --------------------------------------------------------------------
  // One atlas fetch, then slice it into a canvas per row: a single network
  // round trip, and each row still gets its own independently scrolling
  // (and GPU-tiling) texture.
  const atlas = new Image();
  atlas.src = wallUrl;
  atlas
    .decode()
    .then(() => {
      if (disposed) return;
      const rowPx = atlas.naturalHeight / ROWS;
      const maxAniso = renderer.capabilities.getMaxAnisotropy();
      textures = Array.from({ length: ROWS }, (_, i) => {
        const slice = document.createElement("canvas");
        slice.width = atlas.naturalWidth;
        slice.height = rowPx;
        slice.getContext("2d")!.drawImage(atlas, 0, i * rowPx, slice.width, rowPx, 0, 0, slice.width, rowPx);
        const tex = new THREE.CanvasTexture(slice);
        tex.wrapS = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(maxAniso, 4);
        tex.offset.x = STAGGER[i];
        return tex;
      });
      textures.forEach((tex, i) => {
        materials[i] = new THREE.MeshBasicMaterial({ map: tex });
      });
      resize(); // builds meshes with repeat.x now that textures exist
      renderFrame();
      opts.onReady();
      wake();
    })
    .catch(() => {
      // Atlas fetch failed (offline etc.) — leave the plain backdrop.
    });

  return {
    dispose() {
      disposed = true;
      sleep();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion.removeEventListener("change", onMotionChange);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      for (const m of meshes) m.geometry.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
