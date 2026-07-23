-- External links: store the IMDb id so detail pages can link
-- straight to the title instead of a search. Shows already fetch
-- external_ids for tvdb matching; movies carry imdb_id on the base TMDB
-- payload. Backfills as rows re-sync (7-day on-demand window, nightly cron,
-- ToS sweep) — until then the UI falls back to an IMDb title search.

ALTER TABLE shows  ADD COLUMN imdb_id TEXT;
ALTER TABLE movies ADD COLUMN imdb_id TEXT;
