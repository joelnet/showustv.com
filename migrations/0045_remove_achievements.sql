-- Deploy the application without achievement reads/writes before applying.
-- Remove earned awards and the unused tiered-badge schema reserved in 0001.
DROP TABLE IF EXISTS user_achievements;
DROP TABLE IF EXISTS badge_progress;
DROP TABLE IF EXISTS user_badges;
DROP TABLE IF EXISTS badges;
