-- Wait list (issue #26). The site is closed pending licensing data, so new
-- sign-ups join a wait list: the account is created (holding their email +
-- password) but flagged, which blocks sign-in until the site opens.
ALTER TABLE users ADD COLUMN waitlisted INTEGER NOT NULL DEFAULT 0 CHECK (waitlisted IN (0,1));

-- Global key/value settings. site_open gates wait-list enforcement: while '0'
-- (closed), waitlisted users can't sign in; flipping it to '1' opens the site
-- to everyone (existing waitlisted accounts can then sign in unchanged).
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO app_settings (key, value) VALUES ('site_open', '0');
