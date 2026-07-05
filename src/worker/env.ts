export interface Env {
  DB: D1Database;
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

// Set by the auth middleware. tz rides in the session cookie so authenticated
// requests cost zero D1 reads.
export interface Vars {
  uid: number;
  tz: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
