-- Watch Now's "Not Started" section now includes the user's Watch Later
-- movies alongside their not-started shows, with the whole section sorted by
-- when each title was added. Shows have user_shows.added_at; user_movies
-- never had an equivalent — the Watch Later subtab approximated recency with
-- movie_id DESC. Nullable because ALTER TABLE can't add a column with a
-- non-constant default: rows from before this migration stay NULL and sort
-- as oldest (with the old movie_id-DESC proxy as their tiebreak); every
-- user_movies insert path stamps it going forward.
ALTER TABLE user_movies ADD COLUMN added_at TEXT;
