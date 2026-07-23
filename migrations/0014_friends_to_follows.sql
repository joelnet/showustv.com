-- Replace the mutual friendships model with asymmetric,
-- Instagram-style follows. The `follows` table (reserved in 0001) becomes the
-- live social graph. Every account is public today (users.is_private is never
-- set anywhere), so a follow is always 'active' and needs no approval; the
-- 'pending' state stays reserved for a future private-account feature.
--
-- Data migration: an accepted friendship becomes a reciprocal pair of active
-- follows; a still-pending request becomes the requester following the
-- addressee (a public follow needs no accept step).

INSERT OR IGNORE INTO follows (follower_id, followee_id, state, created_at)
  SELECT requester_id, addressee_id, 'active', created_at
  FROM friendships;

INSERT OR IGNORE INTO follows (follower_id, followee_id, state, created_at)
  SELECT addressee_id, requester_id, 'active', COALESCE(accepted_at, created_at)
  FROM friendships
  WHERE status = 'accepted';

-- friendships is intentionally left in place (now dormant) rather than dropped.
-- Migrations apply before the new Worker deploys, so dropping it here would
-- break the still-live old code's /social/* queries during that window. A later
-- migration can drop it once the follows-based code is confirmed live
-- (expand/contract). The feed-support indexes added in 0004 (on user_shows /
-- user_movies / ratings) are still used by the activity feed and stay.
