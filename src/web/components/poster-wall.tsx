// Loader for the landing hero's poster wall. This stays in the main bundle
// (~1 KB); the three.js scene and the strip images are a separate lazy chunk
// pulled in after idle so they never compete with the hero screenshot's LCP.
// Every failure mode (no WebGL2, offline, saveData, chunk error) degrades to
// the hero's existing glow backdrop — the wrapper div just stays empty.
import { useEffect, useRef } from "react";
import type { PosterWallHandle } from "./poster-wall-scene";

export function PosterWall() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    let cancelled = false;
    let scene: PosterWallHandle | undefined;
    const idle = (cb: () => void) =>
      "requestIdleCallback" in window ? requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 300);

    idle(() => {
      if (cancelled || !el.isConnected) return;
      import("./poster-wall-scene")
        .then((m) => {
          if (cancelled || !el.isConnected) return;
          scene = m.mountPosterWall(el, {
            onReady: () => el.classList.add("poster-wall--on"),
          });
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
      scene?.dispose();
    };
  }, []);

  return <div ref={ref} className="poster-wall" aria-hidden="true" />;
}
