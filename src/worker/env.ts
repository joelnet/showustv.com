export interface Env {
  DB: D1Database;
  // Static-assets binding (wrangler.jsonc `assets.binding`). Used by the
  // social-preview path (issue #211) to fetch the SPA shell for meta
  // rewriting and as the passthrough for title-page requests it won't handle.
  ASSETS: Fetcher;
  TMDB_API_BASE: string;
  TMDB_IMG_BASE: string;
  TMDB_TOKEN: string;
  SESSION_SECRET: string;
  // Cloudflare Email Service (send_email binding). Present in production once
  // the domain is onboarded (`wrangler email sending enable showustv.com`);
  // absent locally, where DISABLE_EMAIL_SEND logs instead. Missing binding and
  // not disabled → mail fails closed.
  EMAIL?: EmailBinding;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  DISABLE_EMAIL_SEND?: string; // "true" in .dev.vars only: log mail to console instead of sending
  // Web Push / VAPID (issue #129). Both keys come from `npx web-push
  // generate-vapid-keys`, stored as secrets (wrangler secret put). Until they
  // are set, push delivery no-ops and the app is in-app-notifications-only —
  // see lib/push.ts.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string; // contact URL/mailto claimed in the VAPID JWT; var in wrangler.jsonc
}

// The send_email binding's object-form send() isn't in @cloudflare/workers-types
// yet (it types the older raw-MIME EmailMessage form), so declare the shape we call.
export interface EmailBinding {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

// Set by the auth middleware. tz rides in the session cookie; requireAuth adds
// a single indexed users read to verify the session_epoch + account state
// (issue #355), the price of server-side session revocation.
export interface Vars {
  uid: number;
  tz: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
