-- Shadow ban. A banned user's comments are invisible to
-- everyone else — rendered exactly like deleted ones ([deleted] placeholder
-- where non-banned replies exist, pruned otherwise) — while the banned user
-- keeps seeing their own posts normally, so nothing tips them off. Admins
-- toggle this from the profile page (routes/admin.ts).

ALTER TABLE users ADD COLUMN shadow_banned INTEGER NOT NULL DEFAULT 0 CHECK (shadow_banned IN (0,1));
