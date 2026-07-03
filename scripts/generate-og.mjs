// One-shot generator for the social-share (Open Graph / Twitter) preview
// image at src/web/public/og.png (1200x630, issue #24). Mirrors the brand:
// slate room, amber TV bug, SMPTE bars. Output is committed — re-run only
// when the art or copy changes.
//
// Run from the repo root: node scripts/generate-og.mjs
// Uses sharp (transitive dep) to rasterize the SVG. Text is drawn with a
// system sans (DejaVu) since the web fonts aren't available to the rasterizer.

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SLATE = "#0f1218";
const SURFACE = "#171c26";
const AMBER = "#ffae2e";
const AMBER_INK = "#1a1205";
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

// SMPTE bar colors (match .smpte in styles.css).
const BARS = ["#b8b8ac", "#b8b855", "#55b8ac", "#55b855", "#b855ac", "#b85555", "#5555b8"];
const barW = 60;
const smpte = BARS.map((c, i) => `<rect x="${100 + i * (barW + 8)}" y="540" width="${barW}" height="8" rx="4" fill="${c}"/>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="22%" cy="18%" r="75%">
      <stop offset="0%" stop-color="${AMBER}" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="${AMBER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${SLATE}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- large faded TV bug, decorative -->
  <g transform="translate(838 150) scale(11)" opacity="0.08">${tv}</g>

  <!-- wordmark: SHOW US + TV bug -->
  <text x="100" y="150" font-family="${FONT}" font-size="52" font-weight="bold" font-style="italic" fill="${TEXT}" letter-spacing="1">SHOW US</text>
  <g transform="translate(410 104) scale(1.72)">${tv}</g>

  <!-- ON AIR chip -->
  <g transform="translate(506 118)">
    <rect x="0" y="0" width="128" height="30" rx="15" fill="${SURFACE}" stroke="${RED}" stroke-opacity="0.5"/>
    <circle cx="20" cy="15" r="5" fill="${RED}"/>
    <text x="36" y="20" font-family="${FONT}" font-size="15" font-weight="bold" fill="${RED}" letter-spacing="2">ON AIR</text>
  </g>

  <!-- headline -->
  <text x="100" y="290" font-family="${FONT}" font-size="62" font-weight="bold" font-style="italic" fill="${TEXT}">Never lose your place</text>
  <text x="100" y="366" font-family="${FONT}" font-size="62" font-weight="bold" font-style="italic" fill="${TEXT}">in a show <tspan fill="${AMBER}">again</tspan></text>

  <!-- subtext -->
  <text x="102" y="440" font-family="${FONT}" font-size="30" fill="${MUTED}">Track every show &amp; movie you watch — your Watch Next queue,</text>
  <text x="102" y="480" font-family="${FONT}" font-size="30" fill="${MUTED}">air dates, and history. A home for TV Time refugees.</text>

  ${smpte}
</svg>`;

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public");
await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, "og.png"));
console.log("og.png (1200x630)");
