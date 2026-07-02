export interface Env {
  DB: D1Database;
  TMDB_API_BASE: string;
  TMDB_IMG_BASE: string;
  TMDB_TOKEN: string;
  SESSION_SECRET: string;
}

// Set by the auth middleware. tz rides in the session cookie so authenticated
// requests cost zero D1 reads.
export interface Vars {
  uid: number;
  tz: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
