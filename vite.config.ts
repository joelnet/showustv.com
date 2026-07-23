import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";

// New-version detection. public/sw.js is copied verbatim, so
// without this its bytes never change and browsers never see a deploy as a
// service-worker update. Stamp its __BUILD_ID__ placeholder with a hash of
// every other emitted client file (hashed bundles, index.html, icons,
// manifest…), so the id changes exactly when a deploy ships different
// client bytes: a rebuild of identical code doesn't nag users with a
// phantom update toast, and a Worker-only deploy deliberately doesn't
// prompt either — reloading would fetch the very same client. sw.js itself
// is excluded because it is the stampee; hand-edits to it already register
// as an update on their own.
function swBuildId(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "sw-build-id",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir);
      const swPath = path.join(outDir, "sw.js");
      const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
        .filter((f) => f !== swPath)
        .sort();
      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(path.relative(outDir, file)); // renames count too
        hash.update(await readFile(file));
      }
      const id = hash.digest("hex").slice(0, 12);
      const sw = await readFile(swPath, "utf8");
      await writeFile(swPath, sw.replace('"__BUILD_ID__"', JSON.stringify(id)));
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), swBuildId()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
