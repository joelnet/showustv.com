# showustv

A Social TV show (and movie) tracker: follow shows, mark episodes watched, keep a watchlist, rate things, and build shareable lists. Metadata comes from [TMDB](https://www.themoviedb.org/).

The whole app is a single Cloudflare Worker: it serves a React SPA as static assets and handles `/api/*` with Hono, backed by a D1 (SQLite) database.

## Tech stack

- **Frontend:** React 19 + React Router 7, built with Vite 6 (plain SPA, no SSR), [Lucide](https://lucide.dev/) icons (brand marks stay hand-inlined SVG)
- **Backend:** Hono 4 on a Cloudflare Worker (`src/worker/index.ts`)
- **Database:** Cloudflare D1 (SQLite, STRICT tables), migrations in `migrations/`
- **External API:** TMDB v3 API (accepts a v4 read token or a v3 API key)
- **Language/tooling:** TypeScript (strict, `noEmit` — Vite/Wrangler do the bundling), Wrangler 4

## Repo layout

```
src/
  web/            React SPA (Vite root)
    pages/        Route components (watch now, search, show, episode, library, lists, settings, ...)
    components/   Shared UI (dialogs, icons, primitives)
    api.ts        Fetch wrapper for /api/*
  worker/         Cloudflare Worker
    index.ts      Hono app (basePath /api) + nightly cron handler
    env.ts        Bindings/vars types
    routes/       auth, catalog, library, ratings, lists, public, profile, social, comments, import, admin
    lib/          session (signed cookies), password (PBKDF2), tmdb client, date helpers
  shared/         Constants shared by web and worker
migrations/       D1 SQL migrations
docs/             Notes on architecture and specific features
wrangler.jsonc    Worker config: assets, D1 binding, cron trigger, TMDB vars
vite.config.ts    Vite config (root src/web, output dist/client)
```

## Prerequisites

- Node.js and npm (Node 20+ recommended; not enforced by the repo, but Wrangler 4 and Vite 6 expect a recent runtime)
- A TMDB API token — either a v4 read access token or a v3 API key (free account at themoviedb.org)
- A Cloudflare account (only for deploying; local dev runs entirely on your machine)

## Local development

```sh
npm install
```

Create `.dev.vars` in the repo root (gitignored):

```sh
TMDB_TOKEN=<your TMDB v4 read token or v3 API key>
SESSION_SECRET=<any long random string, e.g. `openssl rand -hex 32`>
```

To test browser push notifications locally, also add the two VAPID keys — see
[Web Push notifications](#web-push-notifications-optional). Without them the
app still works; it just stays in-app-notifications-only.

Apply migrations to the local D1 database, then start the dev server:

```sh
npm run db:migrate:local
npm run dev
```

`npm run dev` runs `vite build` and then `wrangler dev`, which serves the SPA and the API from one local Worker (default: http://localhost:8787). There is no Vite dev server / HMR — after frontend changes, restart `npm run dev` (or run `npx vite build --watch` in a second terminal alongside `wrangler dev`).

Other scripts:

```sh
npm run check    # typecheck worker + web (tsc --noEmit, two tsconfigs)
npm run build    # build the SPA into dist/client
```

There is no test suite or linter configured.

## Deploy

One-time setup:

```sh
npx wrangler d1 create showustv
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing the `REPLACE_AFTER_wrangler_d1_create` placeholder. Then:

```sh
npm run db:migrate:remote
npx wrangler secret put TMDB_TOKEN
npx wrangler secret put SESSION_SECRET
npm run deploy
```

`TMDB_API_BASE` and `TMDB_IMG_BASE` are plain vars already set in `wrangler.jsonc`.

To enable browser push notifications, also set the two VAPID secrets — see
[Web Push notifications](#web-push-notifications-optional).

### CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` typechecks and builds on pull requests and pushes
to `main` (feature branches are covered by their PR), and on a merge to `main` it
applies remote D1 migrations and runs `wrangler deploy`.

One-time setup — add repository secrets (Settings → Secrets and variables →
Actions):

- `CLOUDFLARE_API_TOKEN` — a token with **Workers Scripts: Edit**, **D1: Edit**,
  and **Workers Routes: Edit** on the account.
- `CLOUDFLARE_ACCOUNT_ID` — optional; only needed if the token spans multiple
  accounts.

App secrets (`TMDB_TOKEN`, `SESSION_SECRET`) stay out of CI — set them once with
`wrangler secret put`; they persist across deploys.

## Web Push notifications (optional)

In-app notifications always work. Browser push (the PWA kind, delivered via the
service worker) is a feature flag: it stays dormant until **both** VAPID keys
are configured. Until then push delivery no-ops and the settings page doesn't
offer the push toggle (`/api/notifications/prefs` returns `pushPublicKey: null`).

Generate a key pair once (the repo doesn't depend on `web-push`; `npx` fetches
it on demand):

```sh
npx web-push generate-vapid-keys
```

Three values are involved:

- `VAPID_PUBLIC_KEY` (secret) — the generated public key. Sent to browsers as
  the push `applicationServerKey`.
- `VAPID_PRIVATE_KEY` (secret) — the generated private key. Signs the VAPID JWT
  on every push send. Never commit it.
- `VAPID_SUBJECT` (plain var, already set in `wrangler.jsonc`) — an `https:` or
  `mailto:` contact URL a push service can use to reach the operator. Defaults
  to `https://showustv.com`; change it if you run your own instance.

**Production** — set both keys as Worker secrets (like the other app secrets,
they persist across deploys):

```sh
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

**Local dev** — add the same two values to `.dev.vars` (push works on
`http://localhost`, which browsers treat as a secure context):

```sh
VAPID_PUBLIC_KEY=<generated public key>
VAPID_PRIVATE_KEY=<generated private key>
```

Notes:

- Both keys must be present before push turns on; with only one set, push stays
  off. But the guard checks presence, not that the pair matches — overwriting
  just one key of an existing pair leaves push "on" with every send failing, so
  always set/rotate the two together.
- Changing the key pair later breaks existing subscriptions (they were minted
  against the old public key) — affected users have to toggle push off and back
  on in Settings. Treat the pair as set-once.
- Push is best-effort by design — a failed send never fails the request that
  triggered it (see `src/worker/lib/push.ts`).

## Admin CLI

`scripts/admin.mjs` is a scriptable admin tool that talks straight to D1 via
`wrangler d1 execute` — no running server, no auth. It defaults to the **local**
database; pass `--remote` for production. Every command supports `--json`.

```sh
npm run admin -- help                        # all commands
npm run admin -- users --search someone@example.com
npm run admin -- activity --errors --limit 20
npm run admin -- stats
```

Covers the audit log (`activity`), account lookup and flags
(`users`/`user`/`admin`/`ban`), instance `stats`, and a read-only `sql` escape
hatch. (Note the `--` so npm passes flags through to the tool.)

## Architecture notes

- **One Worker for everything.** Static assets from `dist/client` answer all requests with SPA fallback (`not_found_handling: "single-page-application"`); only `/api/*` runs the Worker first (`run_worker_first`). The Hono app is mounted at `/api` and returns JSON 404s for unknown API paths.
- **Auth.** Username + password (PBKDF2 hashes in D1). Sessions are stateless HMAC-SHA256-signed cookies (30-day TTL) carrying the user id and IANA timezone, so authenticated requests cost zero D1 reads for session lookup. `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/public/*`, and `/api/healthz` are open; everything else (including `/api/auth/me` and `/api/auth/settings`) requires a session.
- **TMDB caching.** The TMDB client caches upstream responses in the edge Cache API (no-op on `*.workers.dev` — only effective on a custom domain). Durable metadata for shows/movies a user touches is mirrored into D1 (`ensureShow`/`ensureMovie`) and considered fresh for 7 days on-demand.
- **Nightly cron (06:00 UTC).** Re-syncs followed, still-airing shows so new episodes and air-date changes land before US mornings, then runs a bounded "ToS sweep" refreshing any cached show/movie rows older than ~5 months (TMDB terms cap caching at 6 months).
- **Time conventions.** All timestamps in D1 are ISO 8601 UTC TEXT; air dates are date-only `YYYY-MM-DD`; user timezones are IANA names.
- **Health check:** `GET /api/healthz` verifies D1 connectivity.
