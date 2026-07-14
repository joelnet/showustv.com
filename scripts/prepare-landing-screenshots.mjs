import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const sourceDir = resolve(process.argv[2] ?? homedir(), process.argv[2] ? "." : "vault/Fleeting");
const outputDir = resolve("src/web/public/landing");

const sources = {
  watch: resolve(sourceDir, "Screenshot_20260714_121423_Brave.jpg"),
  social: resolve(sourceDir, "Screenshot_20260714_121455_Brave.jpg"),
  comments: resolve(sourceDir, "Screenshot_20260714_124740_Brave.jpg"),
};

// The captures are 1440 px wide. Regular Android screenshots include a 96 px
// status bar and a 192 px system-navigation strip. The long capture includes
// the status bar but omits system navigation; its app header/footer boundaries
// were supplied with the source screenshots.
const WIDTH = 1440;
const OUTPUT_WIDTH = 720;
const STATUS_HEIGHT = 96;
const SYSTEM_NAV_TOP = 2928;
const LONG_HEADER_END = 326;
const LONG_FOOTER_HEIGHT = 207;
const LONG_HEIGHT = 7894;

await mkdir(outputDir, { recursive: true });

async function writeSlice(source, output, top, height) {
  await sharp(source)
    .extract({ left: 0, top, width: WIDTH, height })
    .resize({ width: OUTPUT_WIDTH })
    .sharpen({ sigma: 0.6 })
    .webp({ quality: 88, smartSubsample: true })
    .toFile(resolve(outputDir, output));
}

await Promise.all([
  writeSlice(
    sources.watch,
    "watch-now-header.webp",
    STATUS_HEIGHT,
    LONG_HEADER_END - STATUS_HEIGHT,
  ),
  writeSlice(
    sources.watch,
    "watch-now-content.webp",
    LONG_HEADER_END,
    LONG_HEIGHT - LONG_HEADER_END - LONG_FOOTER_HEIGHT,
  ),
  writeSlice(
    sources.watch,
    "watch-now-footer.webp",
    LONG_HEIGHT - LONG_FOOTER_HEIGHT,
    LONG_FOOTER_HEIGHT,
  ),
  writeSlice(sources.social, "social-graph.webp", STATUS_HEIGHT, SYSTEM_NAV_TOP - STATUS_HEIGHT),
  writeSlice(sources.comments, "comments.webp", STATUS_HEIGHT, SYSTEM_NAV_TOP - STATUS_HEIGHT),
]);

console.log(`Prepared landing screenshots in ${outputDir}`);
