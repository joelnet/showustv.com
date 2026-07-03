-- Admin users (issue #17). Admins get /api/admin/* (per-user activity-log
-- viewing; shadow-ban toggling arrives with #18). Seeded: joelnet. The
-- UPDATE is a no-op wherever that account doesn't exist (fresh local DBs).

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1));

UPDATE users SET is_admin = 1 WHERE username = 'joelnet';
