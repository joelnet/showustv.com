-- Install tracking (PWA home-screen). iOS Safari fires no `appinstalled` event
-- and gives the browser tab no way to query whether a home-screen copy exists,
-- so the installed app itself pings /api/auth/installed on its first standalone
-- boot. The browser tab reads the flag back via /auth/me and hides its
-- "Install App" affordance for that user — matching how Android's button
-- disappears once installed. NULL = the user has never launched standalone.

ALTER TABLE users ADD COLUMN installed_at TEXT;  -- ISO 8601 UTC; set-once on first standalone boot
