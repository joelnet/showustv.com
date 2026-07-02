// One-shot generator for the PWA app icons in src/web/public/icons/.
// The art is the wordmark's TV bug (see Wordmark in src/web/components/ui.tsx):
// amber tile, dark TV with antennae, amber screen.
//
// Run from the repo root: node scripts/generate-icons.mjs
// Uses sharp (present transitively in node_modules) to rasterize the SVGs.
// Outputs are committed, so this only needs re-running when the art changes.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const AMBER = "#ffae2e";
const INK = "#1a1205";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public/icons");

// The TV mark from the wordmark, in its native 36x30 coordinate space.
const tv = `
    <line x1="12" y1="7" x2="7" y2="1" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="24" y1="7" x2="29" y2="1" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="3" y="7" width="30" height="20" rx="3" ry="3" fill="${INK}"/>
    <rect x="6.5" y="10" width="23" height="13" rx="2" ry="2" fill="${AMBER}"/>
    <rect x="8" y="11.5" width="6" height="3" rx="1" fill="${INK}" opacity="0.18"/>
    <rect x="11" y="27" width="4" height="2.5" rx="1" fill="${INK}"/>
    <rect x="21" y="27" width="4" height="2.5" rx="1" fill="${INK}"/>`;

// scale: TV size within the 512 canvas. rounded: transparent rounded corners
// (regular icons) vs full-bleed square (maskable / apple touch, where the
// platform applies its own mask — art stays inside the safe zone).
function iconSvg({ scale, rounded }) {
  const x = 256 - 18 * scale; // art bbox center: (18, 15.25)
  const y = 256 - 15.25 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="106" ry="106"' : ""} fill="${AMBER}"/>
  <g transform="translate(${x} ${y}) scale(${scale})">${tv}
  </g>
</svg>
`;
}

const regular = iconSvg({ scale: 9, rounded: true });
const maskable = iconSvg({ scale: 8, rounded: false }); // safe zone: r=205 circle
const apple = iconSvg({ scale: 8.6, rounded: false }); // iOS rounds the square itself

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(outDir, file));
  console.log(`${file} (${size}x${size})`);
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "icon.svg"), regular); // favicon
await png(regular, 192, "icon-192.png");
await png(regular, 512, "icon-512.png");
await png(maskable, 512, "icon-maskable-512.png");
await png(apple, 180, "apple-touch-icon.png");
console.log("icon.svg");
