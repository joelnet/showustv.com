-- Configurable signup auto-follow (issue #14). Issue #11 hard-coded
-- "joelnet" as the account every new signup silently follows; the admin
-- panel now stores that username in app_settings (0013) instead, and an
-- empty value turns the feature off. Seed with the previously hard-coded
-- value so deploying this doesn't silently change behavior — clearing the
-- textbox in the admin panel is how the feature gets turned off.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auto_follow_username', 'joelnet');
