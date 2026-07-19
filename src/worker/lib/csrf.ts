// CSRF defense-in-depth (issue #360). The session cookie is SameSite=Lax
// (lib/session.ts), which is the primary CSRF barrier — but it's the *only*
// one, and same-site sibling subdomains stay in scope. For unsafe methods
// (anything that mutates) this middleware adds two cheap, header-only checks
// that run before any route handler:
//
//   1. Reject requests the browser itself flags as cross-site. Sec-Fetch-Site
//      and Origin are forbidden request headers — page JavaScript cannot forge
//      them — so their presence is trustworthy. We reject ONLY on a positive
//      cross-site signal: an absent header (older browsers, and every
//      non-browser caller such as the admin CLI or a cron job) passes through,
//      so legitimate same-origin and server-to-server traffic keeps working.
//
//   2. Require Content-Type: application/json. This closes the text/plain
//      form-post degradation where routes parsing `c.req.json().catch(() => ({}))`
//      silently accepted a cross-site form body as `{}`. A simple (no-preflight)
//      CSRF form submission cannot set Content-Type to application/json, so a
//      request that reaches a handler has already declared JSON.
//
// SameSite=Lax stays in place as an additional layer; this only adds defense.
// GET/HEAD/OPTIONS are safe methods and pass straight through untouched.

import type { Context, Next } from "hono";
import type { AppEnv } from "../env";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function csrfGuard(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // (1) Cross-site rejection. Sec-Fetch-Site is the primary, spoof-proof signal;
  // Origin is the fallback for browsers that don't send Sec-Fetch-Site. Both are
  // only *rejected* on a proven cross-site value — a missing header means a
  // non-browser caller (admin CLI / cron) or an older browser, which we allow.
  if (c.req.header("sec-fetch-site") === "cross-site") {
    return c.json({ error: "cross-site request blocked" }, 403);
  }
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "cross-origin request blocked" }, 403);
  }

  // (2) Require a JSON body declaration. The SPA's api() helper sends
  // application/json on every mutation — including empty-body ones like logout —
  // and so do the service worker and any non-browser caller. A text/plain or
  // form-encoded body (the classic no-preflight CSRF vector) is rejected here
  // instead of degrading to `{}` inside a handler.
  const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return c.json({ error: "content-type must be application/json" }, 415);
  }

  return next();
}
