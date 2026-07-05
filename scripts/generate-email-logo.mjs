// One-shot generator for the transactional-email wordmark bug at
// src/web/public/email-logo.png (issue #54). HTML email clients (Outlook
// especially) don't render inline <svg> reliably, so the site's vector "TV"
// wordmark bug is rasterized to a small PNG the email can <img>. Output is
// committed — re-run only when the wordmark art changes.
//
// Run from the repo root: node scripts/generate-email-logo.mjs
// Uses sharp (transitive dep) to rasterize the SVG, the same technique as
// scripts/generate-og.mjs.

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Brand colors, mirroring styles.css :root.
const AMBER = "#ffae2e"; // --amber
// The "TV" letters are knocked out in the colour of the surface the bug sits
// on, so the amber reads as a lit screen with the caps cut out of it — the
// same trick the live wordmark uses with the page background (var(--bg)).
// In the email the bug sits on the card, so we knock out in --surface.
const KNOCKOUT = "#171c26"; // --surface

// Exactly the TV bug geometry from Wordmark() in src/web/components/ui.tsx
// (viewBox "0 3 30 26"): two amber antennae, an amber rounded-rect body, and
// skewed "TV" letters stroke-drawn in the knockout colour.
const tv = `
    <line x1="12.2" y1="10" x2="5.8" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="17.8" y1="10" x2="24.2" y2="4.2" stroke="${AMBER}" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="1.5" y="9" width="27" height="20" rx="4.5" ry="4.5" fill="${AMBER}"/>
    <g transform="translate(3.37 0) skewX(-10)" stroke="${KNOCKOUT}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M6.8 14.4 H13.6 M10.2 14.4 V23.8"/>
      <path d="M16.6 14.4 L19.6 23.8 L22.6 14.4"/>
    </g>`;

// Native 30x26 wordmark viewBox, rendered at 3x so the bug stays crisp on
// high-DPI screens at its ~30x26 display size. Transparent background so the
// bug composites cleanly onto the email card (also --surface).
const SCALE = 3;
const VB_X = 0;
const VB_Y = 3;
const VB_W = 30;
const VB_H = 26;
const W = VB_W * SCALE; // 90
const H = VB_H * SCALE; // 78

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${VB_X} ${VB_Y} ${VB_W} ${VB_H}">${tv}</svg>`;

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/public");
await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, "email-logo.png"));
console.log(`email-logo.png (${W}x${H})`);
