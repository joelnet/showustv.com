-- Profile pages: users opt in to a public profile at /u/:username and can pin
-- lists to it in an owner-chosen order.

-- Profiles are private by default; the owner flips this from the Profile page.
-- (users.is_private is the account-level social flag — follow approval etc. —
-- and keeps its existing meaning.)
ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0 CHECK (profile_public IN (0,1));

-- NULL = not shown on the profile; otherwise the sort position within it.
ALTER TABLE custom_lists ADD COLUMN profile_position INTEGER;
