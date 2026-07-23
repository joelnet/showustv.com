-- Discord webhook config (issue #8). Moves the new-signup Discord
-- ping from the external notify-new-users.mjs cron into the app: the admin
-- panel stores a webhook URL and a notify-on-signup flag in app_settings
-- (0013), and POST /register fires the message directly. Seed the keys so
-- the settings exist from day one; the code also tolerates absent rows
-- (missing URL = empty, missing flag = off).
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('discord_webhook_url', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('discord_notify_signups', '0');
