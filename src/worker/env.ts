export interface Env {
  DB: D1Database;
  TMDB_API_BASE: string;
  TMDB_IMG_BASE: string;
  TMDB_TOKEN: string;
  SESSION_SECRET: string;
  RESEND_API_KEY?: string; // unset → email fails closed unless DEV_MAIL_LOG=1
  MAIL_FROM?: string;
  DEV_MAIL_LOG?: string; // "1" in .dev.vars only: log mail to console instead of sending
}

// Set by the auth middleware. tz rides in the session cookie so authenticated
// requests cost zero D1 reads.
export interface Vars {
  uid: number;
  tz: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
