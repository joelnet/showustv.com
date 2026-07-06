// One-shot generator for the social-share (Open Graph / Twitter) preview
// image at src/web/public/og.png (1200x630, issues #24 + #45). Mirrors the
// brand — slate room, amber TV bug, SMPTE bars — and shows a row of real show
// posters so the card looks like the actual product, not just a text slate.
// Output is committed — re-run only when the art or copy changes.
//
// Run from the repo root: node scripts/generate-og.mjs
// Uses sharp (transitive dep) to rasterize the SVG and composite the posters.
// Poster art is fetched from TMDB at generation time (never bundled); text is
// drawn with a system sans (DejaVu) since the web fonts aren't available to the
// rasterizer.

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SLATE = "#0f1218";
const SURFACE = "#171c26";
const CARD = "#1b212e";
const AMBER = "#ffae2e";
const TEXT = "#ede9e0";
const MUTED = "#9aa3b2";
const RED = "#ff4d3d";
const FONT = "'DejaVu Sans', sans-serif";

const W = 1200;
const H = 630;

// The TV bug from the wordmark, in its native 30-unit coordinate space.
const tv = `
    <line x1="12.2" y1="10" x2="5.8" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="17.8" y1="10" x2="24.2" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="1.5" y="9" width="27" height="20" rx="4.5" ry="4.5" fill="${AMBER}"/>
    <g transform="translate(3.37 0) skewX(-10)" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M6.8 14.4 H13.6 M10.2 14.4 V23.8"/>
      <path d="M16.6 14.4 L19.6 23.8 L22.6 14.4"/>
    </g>`;

// SMPTE bar colors (match .smpte in styles.css). A short accent strip sits
// under the wordmark; kept clear of the poster row so nothing peeks through
// the gaps between cards.
const BARS = ["#b8b8ac", "#b8b855", "#55b8ac", "#55b855", "#b855ac", "#b85555", "#5555b8"];
const barW = 30;
const smpte = BARS.map((c, i) => `<rect x="${100 + i * (barW + 5)}" y="124" width="${barW}" height="7" rx="3.5" fill="${c}"/>`).join("");

// Real TMDB posters, matching the shows used on the landing page showcase so
// the preview stays in sync with the product. w342 is plenty at this size.
const POSTERS = [
  "/eKfVzzEazSIjJMrw9ADa2x8ksLz.jpg", // The Bear
  "/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg", // Severance
  "/dmo6TYuuJgaYinXBPjrgG9mB5od.jpg", // The Last of Us
  "/7O4iVfOMQmdCSxhOg1WnzG1AgYT.jpg", // Shogun
  "/abf8tHznhSvl9BAElD2cQeRr7do.jpg", // Arcane
];

// Poster-row geometry. Cards are a 2:3 frame; posters sit inset inside them so
// the card edge reads as a thin mat around each one.
const CARD_H = 236;
const CARD_W = Math.round((CARD_H * 2) / 3); // 157
const INSET = 4;
const POSTER_W = CARD_W - INSET * 2;
const POSTER_H = CARD_H - INSET * 2;
const ROW_Y = 352;
const MARGIN = 100;
const gap = Math.round((W - MARGIN * 2 - POSTERS.length * CARD_W) / (POSTERS.length - 1));
const cardX = (i) => MARGIN + i * (CARD_W + gap);

// Card mats drawn behind the posters, with a faint edge highlight.
const cards = POSTERS.map(
  (_, i) =>
    `<rect x="${cardX(i)}" y="${ROW_Y}" width="${CARD_W}" height="${CARD_H}" rx="13" fill="${CARD}" stroke="#ffffff" stroke-opacity="0.07"/>`,
).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="20%" cy="16%" r="80%">
      <stop offset="0%" stop-color="${AMBER}" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="${AMBER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${SLATE}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- wordmark: SHOW US + TV bug -->
  <text x="100" y="98" font-family="${FONT}" font-size="46" font-weight="bold" font-style="italic" fill="${TEXT}" letter-spacing="1">SHOW US</text>
  <g transform="translate(372 56) scale(1.52)">${tv}</g>

  <!-- ON AIR chip -->
  <g transform="translate(452 68)">
    <rect x="0" y="0" width="118" height="28" rx="14" fill="${SURFACE}" stroke="${RED}" stroke-opacity="0.5"/>
    <circle cx="19" cy="14" r="4.5" fill="${RED}"/>
    <text x="33" y="19" font-family="${FONT}" font-size="14" font-weight="bold" fill="${RED}" letter-spacing="2">ON AIR</text>
  </g>

  <!-- headline -->
  <text x="100" y="205" font-family="${FONT}" font-size="58" font-weight="bold" font-style="italic" fill="${TEXT}">Track your shows.</text>
  <text x="100" y="278" font-family="${FONT}" font-size="58" font-weight="bold" font-style="italic" fill="${TEXT}">Pickup where you <tspan fill="${AMBER}">left off</tspan>.</text>

  <!-- subtext -->
  <text x="102" y="330" font-family="${FONT}" font-size="27" fill="${MUTED}">Your Watch Now queue, air dates, and full history.</text>

  ${smpte}
  ${cards}
</svg>`;

// Fetch a poster from TMDB and mask it to rounded corners so it sits neatly
// inside its card mat.
async function roundedPoster(tmdbPath) {
  const url = `https://image.tmdb.org/t/p/w342${tmdbPath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TMDB ${res.status} fetching ${tmdbPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_W}" height="${POSTER_H}"><rect width="${POSTER_W}" height="${POSTER_H}" rx="10" ry="10" fill="#fff"/></svg>`,
  );
  return sharp(buf)
    .resize(POSTER_W, POSTER_H, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

const rounded = await Promise.all(POSTERS.map(roundedPoster));
const composites = rounded.map((input, i) => ({
  input,
  left: cardX(i) + INSET,
  top: ROW_Y + INSET,
}));

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public");
await sharp(Buffer.from(svg)).composite(composites).png().toFile(path.join(outDir, "og.png"));
console.log("og.png (1200x630)");
