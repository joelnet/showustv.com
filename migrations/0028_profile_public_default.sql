-- Profiles are public by default (issue #243).
--
-- SQLite can't alter a column's default in place, and rebuilding the central
-- users table just to flip DEFAULT 0 -> 1 isn't worth the risk, so the new
-- default lives in the app layer: the register INSERT now sets
-- profile_public = 1 explicitly for every new account.
--
-- Existing accounts are flipped public here (all rows, per the issue).
-- Owners can still switch back to private from the Profile page.
UPDATE users SET profile_public = 1;
