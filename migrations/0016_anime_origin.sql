-- Anime tab: classify a title as anime when it's animated *and*
-- Japanese in origin — Animation genre plus original_language = 'ja'. We already
-- store genres_json but not the origin language, so add it to both shows and
-- movies. Nullable: existing rows stay NULL until the nightly show sync and
-- movie re-syncs repopulate original_language over time.

ALTER TABLE shows  ADD COLUMN original_language TEXT;  -- ISO 639-1, e.g. 'ja'; NULL until re-synced
ALTER TABLE movies ADD COLUMN original_language TEXT;  -- ISO 639-1, e.g. 'ja'; NULL until re-synced
