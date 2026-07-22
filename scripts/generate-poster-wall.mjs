// One-shot generator for the landing-page poster wall: a single atlas of TMDB
// trending posters (src/web/assets/poster-wall/wall.webp), ROWS rows of
// PER_ROW posters stacked vertically. The three.js scene fetches it once,
// slices it into row textures, and tiles them into a slowly scrolling concave
// wall behind the hero copy — one network round trip for all the art.
//
// Outputs are committed (same pattern as generate-og.mjs / generate-icons.mjs).
// Like og.png, the strips are a curated marketing composite — the required
// TMDB attribution renders in SiteFooter on the landing page. Re-run at least
// every ~6 months (TMDB's cap on how long its image data may be cached);
// manifest.json records the titles and the generatedAt date to track that
// cadence.
//
// Run from the repo root: node scripts/generate-poster-wall.mjs
// Needs TMDB_TOKEN in .dev.vars for the trending-list API calls; the poster
// image downloads themselves are keyless.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROWS = 4;
const PER_ROW = 16;
const POSTER_W = 154; // native TMDB w154 — no upscaling
const POSTER_H = 231;
const GUTTER = 6; // baked slate gutter; opaque (not alpha) to avoid mip fringing
const TILE_W = POSTER_W + GUTTER; // 160
const STRIP_W = PER_ROW * TILE_W; // 2560
const SLATE = "#0f1218"; // --bg
const QUALITY = 55;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src/web/assets/poster-wall");

// --- TMDB token from .dev.vars (gitignored) ---------------------------------
function readToken() {
  const devVars = path.join(root, ".dev.vars");
  if (fs.existsSync(devVars)) {
    for (const line of fs.readFileSync(devVars, "utf8").split("\n")) {
      const m = line.match(/^TMDB_TOKEN\s*=\s*"?([^"\s]+)"?/);
      if (m) return m[1];
    }
  }
  if (process.env.TMDB_TOKEN) return process.env.TMDB_TOKEN;
  console.error("TMDB_TOKEN not found in .dev.vars or the environment.");
  process.exit(1);
}
const TOKEN = readToken();

async function tmdb(pathname) {
  const res = await fetch(`https://api.themoviedb.org/3${pathname}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} fetching ${pathname}`);
  return res.json();
}

// --- Pick the posters: trending this week, popularity order, tv/movie mixed --
const NEED = ROWS * PER_ROW;
const pool = new Map(); // "type:id" -> {id, type, title, poster_path, popularity}

function add(items, type) {
  for (const r of items) {
    if (!r.poster_path || r.adult) continue;
    const key = `${type}:${r.id}`;
    if (!pool.has(key)) {
      pool.set(key, {
        id: r.id,
        type,
        title: r.title ?? r.name ?? "",
        poster_path: r.poster_path,
        popularity: r.popularity ?? 0,
      });
    }
  }
}

for (const page of [1, 2]) {
  add((await tmdb(`/trending/tv/week?page=${page}`)).results ?? [], "tv");
  add((await tmdb(`/trending/movie/week?page=${page}`)).results ?? [], "movie");
}
if (pool.size < NEED) {
  add((await tmdb("/tv/popular?page=1")).results ?? [], "tv");
  add((await tmdb("/movie/popular?page=1")).results ?? [], "movie");
}
if (pool.size < NEED) {
  console.error(`Only ${pool.size} usable posters (need ${NEED}).`);
  process.exit(1);
}

// Interleave tv/movie (each popularity-sorted) so neither medium clumps.
const byType = { tv: [], movie: [] };
for (const item of pool.values()) byType[item.type].push(item);
for (const list of Object.values(byType)) list.sort((a, b) => b.popularity - a.popularity);
const picked = [];
while (picked.length < NEED) {
  // Alternate tv/movie while both remain; drain whichever is left otherwise.
  const preferTv = picked.length % 2 === 0;
  const source = (preferTv ? byType.tv : byType.movie).length ? (preferTv ? byType.tv : byType.movie) : byType.tv.length ? byType.tv : byType.movie;
  if (!source.length) break;
  picked.push(source.shift());
}
const rows = Array.from({ length: ROWS }, (_, i) => picked.slice(i * PER_ROW, (i + 1) * PER_ROW));

// --- Fetch + composite each row strip ----------------------------------------
async function posterTile(item) {
  const url = `https://image.tmdb.org/t/p/w154${item.poster_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TMDB ${res.status} fetching ${item.poster_path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return sharp(buf)
    .resize(POSTER_W, POSTER_H, { fit: "cover" })
    // Bake a slight desaturation (the analog fade); brightness stays a runtime
    // knob (--wall-opacity + the hero glow layer) so tuning needs no re-gen.
    .modulate({ saturation: 0.85 })
    .png()
    .toBuffer();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

fs.mkdirSync(outDir, { recursive: true });
const composites = [];
for (const [i, row] of rows.entries()) {
  const tiles = await mapLimit(row, 8, posterTile);
  composites.push(...tiles.map((input, j) => ({ input, left: j * TILE_W + Math.floor(GUTTER / 2), top: i * POSTER_H })));
  console.log(`row ${i + 1}: ${row.map((r) => r.title).join(", ")}`);
}
const file = path.join(outDir, "wall.webp");
await sharp({
  create: { width: STRIP_W, height: ROWS * POSTER_H, channels: 3, background: SLATE },
})
  .composite(composites)
  .webp({ quality: QUALITY })
  .toFile(file);
console.log(`wall.webp (${STRIP_W}x${ROWS * POSTER_H}, ${Math.round(fs.statSync(file).size / 1024)} KB)`);

fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      rows: rows.map((row) => row.map(({ id, type, title, poster_path }) => ({ id, type, title, poster_path }))),
    },
    null,
    2,
  ) + "\n",
);
console.log(`manifest.json (${NEED} posters)`);
