---
title: How a title is categorized as Anime
purpose: The rule that puts a show or movie in the Anime tab, where the classification runs, and how the underlying data (original_language) is populated and backfilled. Issue #85.
---

## The rule

A title (show **or** movie) is **Anime** when both hold:

1. Its genres include **`"Animation"`**, and
2. Its **original language is Japanese** — `original_language == "ja"`.

Japanese-only for now. The same rule applies to shows and movies because TMDB
exposes the same `genres` + `original_language` fields on both the `/tv` and
`/movie` objects.

## Where the rule lives (two twins — keep in sync)

The rule is written **twice**, once in JS and once as a SQL predicate. Both must
stay identical — each carries a `KEEP THE TWO IN SYNC` comment.

- **JS:** `isAnime(genres, originalLanguage)` in `src/shared/anime.ts`.
  Used when the server has already loaded rows and splits them in memory, and on
  the client for grouping list items (`src/web/pages/lists.tsx`).
- **SQL:** `animeCond(tableAlias)` in `src/worker/lib/library.ts`. Used where a
  query must `LIMIT` each section independently (e.g. profile history rows, issue
  #245) so a fetch-then-split-in-JS can't let recent anime starve the Shows row.

```ts
// src/shared/anime.ts
originalLanguage === "ja" && genres.some((g) => g === "Animation")
```

```sql
-- src/worker/lib/library.ts, animeCond()
COALESCE(t.original_language, '') = 'ja'
  AND EXISTS (SELECT 1 FROM json_each(t.genres_json) WHERE json_each.value = 'Animation')
```

`COALESCE(..., '')` means a `NULL` **or** empty-string `original_language` is
treated as not-anime (never as a SQL `NULL` that would vanish from both
branches).

## Classification is derived at read time, never stored

There is no `is_anime` column. Every request recomputes the rule from the two
stored inputs on the `shows` / `movies` row:

- `genres_json` — a JSON array of TMDB genre **names**, e.g. `["Animation","Drama"]`.
- `original_language` — the raw TMDB ISO-639-1 code, e.g. `"ja"`.

The library handler (`src/worker/lib/library.ts`) selects both columns, runs
`isAnime` per row, pushes the row into the `anime*` bucket or the regular bucket,
and strips the classification-only columns from the payload — so an anime title
appears under the Anime tab only, not also under Shows/Movies.

## Where the inputs come from

Both fields are written during the TMDB sync in `src/worker/lib/tmdb.ts`
(`ensureShow` / `ensureMovie`), which upserts the row from the TMDB `/tv/{id}` or
`/movie/{id}` payload. A sync happens:

- on demand when a title page is opened, if the row is >7 days stale;
- for followed, still-airing shows, nightly (the cron's primary sync);
- for anything untouched ~5 months, via the cron's TMDB ToS refresh sweep.

## Why a Japanese anime can still land under Shows (the 0016 gap)

`original_language` was **added by migration `0016_anime_origin.sql`** as a
**nullable** column. Every row that existed before that migration kept
`original_language = NULL` until it was next re-synced. Because
`NULL != "ja"`, such a title fails the rule and sits under Shows even though its
`genres_json` still contains `"Animation"`.

The nightly primary sync **skips `Ended`/`Canceled` shows** (they have no new
episodes), so an *ended* anime — e.g. **Neon Genesis Evangelion** — would not get
its `original_language` backfilled by the primary sync. It would only be fixed
whenever the slow ~5-month ToS sweep happened to touch it, or when someone opened
its title page.

## The backfill (fixes the gap)

Two changes close this (`src/worker/lib/tmdb.ts` + `src/worker/index.ts`):

1. **Sentinel on write.** `ensureShow` / `ensureMovie` now write `""` (empty
   string), never `NULL`, when TMDB returns no `original_language`. After this, a
   `NULL` means exactly one thing: *the row has not been synced since migration
   0016*. `""` classifies as not-anime identically to `NULL` in both twins.

2. **Nightly backfill block** in the cron re-syncs a bounded batch
   (`WHERE original_language IS NULL LIMIT 20`, shows + movies), **regardless of
   status**. A successful sync clears the `NULL` (to `"ja"`, another real code, or
   `""`), so this drains the one-time pre-0016 backlog over a few nights and then
   no-ops.

   - **Permanent 404** (title deleted from TMDB): the sync throws and would leave
     the row `NULL` forever, re-selected every night — and 20+ such rows would
     starve the `LIMIT`. So on a `TmdbError` with status 404 the backfill stamps
     `""`, dropping the dead row out of the query.
   - **Transient failure** (5xx / network): the row stays `NULL` and correctly
     retries next run.

## Practical: a specific title is mis-tabbed

If a Japanese animated title is under Shows instead of Anime, its stored
`original_language` is almost certainly still `NULL` (a pre-0016 row not yet
re-synced). Fastest fixes:

- Open its title page once — forces an on-demand re-sync that populates
  `original_language`; it moves on the next library load.
- Or wait for the nightly backfill to reach it.

## Files

- `src/shared/anime.ts` — `isAnime()` (JS rule).
- `src/worker/lib/library.ts` — `animeCond()` (SQL twin) + library partition.
- `src/worker/lib/tmdb.ts` — `ensureShow` / `ensureMovie` write the inputs (`""` sentinel).
- `src/worker/index.ts` — `scheduled()` nightly backfill + 404 guard.
- `migrations/0016_anime_origin.sql` — adds the nullable `original_language` column.
