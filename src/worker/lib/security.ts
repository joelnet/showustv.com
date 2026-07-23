// Security response headers. Applied in two places that must stay
// in lockstep:
//   1. This module — wraps every response the Worker itself returns (the Hono
//      /api surface, the per-title/profile social-preview shells, and the RSS
//      feed). See src/worker/index.ts.
//   2. src/web/public/_headers — the Cloudflare static-asset server applies the
//      SAME headers to everything served WITHOUT the Worker (the SPA shell on a
//      cold navigation, /assets/* JS+CSS, /sw.js, icons, manifest, og.png…).
// Keep the CSP below byte-identical with the one in _headers.
//
// CSP was built from exactly what the app loads (verified against the Vite
// build output, the service worker, and every browser-side fetch):
//   • script-src 'self'      — the built bundle is one same-origin module
//     (<script type="module" src="/assets/…js">); there is NO inline script,
//     no eval, no new Function, no blob/data script. No nonce/hash needed.
//   • style-src …'unsafe-inline' https://fonts.googleapis.com — the Google
//     Fonts stylesheet is cross-origin; 'unsafe-inline' covers any runtime
//     <style> a UI dependency injects (React's own style={} prop goes through
//     the CSSOM, which CSP does not gate). Scoped to style only — never script.
//   • font-src https://fonts.gstatic.com — the actual font files.
//   • img-src 'self' data: https://image.tmdb.org — local art (og.png, icons,
//     landing webp) + hotlinked TMDB posters/stills/backdrops (src/web/img.ts).
//   • connect-src 'self' image.tmdb.org fonts.* — 'self' for /api; image.tmdb.org
//     because the offline precache fetch()es posters (src/web/precache.ts) AND
//     the service worker re-fetches images+fonts under its own copy of this CSP.
//   • worker-src 'self' — the service worker (/sw.js). manifest-src 'self'.
//   • object-src 'none', base-uri 'self', frame-ancestors 'none', frame-src
//     'none' — locked down; the app embeds nothing and must not be embedded.
//   • No 'unsafe-eval'. No third-party analytics origins (the app runs none).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://image.tmdb.org",
  "connect-src 'self' https://image.tmdb.org https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Turn off device APIs the app never uses. Notifications, Web Push, Web
  // Share, and clipboard-write (used by Share/admin copy) are intentionally
  // left at their permissive defaults so they keep working.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // HSTS. Ignored by browsers over plain http (so `wrangler dev` is unaffected);
  // enforced on the https apex + staging subdomain. No `preload` here — that is
  // a hard-to-reverse commitment best added deliberately at the zone.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// Re-emit `res` with the security headers added. Existing headers set by a
// handler win (nothing sets these today), so this only fills gaps — it never
// duplicates or clobbers. The body stream is passed through untouched.
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
