// One-shot generator for the PWA app icons in src/web/public/icons/.
// The art is the wordmark's TV bug (see Wordmark in src/web/components/ui.tsx):
// amber TV with antennae and white "TV" letters on the app's slate background.
//
// Run from the repo root: node scripts/generate-icons.mjs
// Uses sharp (present transitively in node_modules) to rasterize the SVGs.
// Outputs are committed, so this only needs re-running when the art changes.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const AMBER = "#ffae2e";
const SLATE = "#0f1218";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public/icons");

// The TV mark from the wordmark, in its native 30-unit coordinate space
// (content spans y 3..29). Letters are stroke-drawn (no font dependency
// in librsvg).
const tv = `
    <line x1="12.2" y1="10" x2="5.8" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="17.8" y1="10" x2="24.2" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="1.5" y="9" width="27" height="20" rx="4.5" ry="4.5" fill="${AMBER}"/>
    <g transform="translate(3.37 0) skewX(-10)" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M6.8 14.4 H13.6 M10.2 14.4 V23.8"/>
      <path d="M16.6 14.4 L19.6 23.8 L22.6 14.4"/>
    </g>`;

// scale: TV size within the 512 canvas. rounded: transparent rounded corners
// (regular icons) vs full-bleed square (maskable / apple touch, where the
// platform applies its own mask — art stays inside the safe zone).
function iconSvg({ scale, rounded }) {
  const x = 256 - 15 * scale; // art bbox center: (15, 16)
  const y = 256 - 16 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" ${rounded ? 'rx="106" ry="106"' : ""} fill="${SLATE}"/>
  <g transform="translate(${x} ${y}) scale(${scale})">${tv}
  </g>
</svg>
`;
}

const regular = iconSvg({ scale: 12, rounded: true });
const maskable = iconSvg({ scale: 10, rounded: false }); // safe zone: r=205 circle
const apple = iconSvg({ scale: 11.5, rounded: false }); // iOS rounds the square itself

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
