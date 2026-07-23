-- Optional list preamble: a short intro the list owner can write to
-- explain why the list exists or what's great about it, shown above the items on
-- their own list page and on the public share page. Nullable; additive, so it's
-- safe to apply before the new code goes live.

ALTER TABLE custom_lists ADD COLUMN preamble TEXT;
