-- Favorites are modeled as a system-kind list, auto-created on first favorite.
ALTER TABLE custom_lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom', 'favorites'));
