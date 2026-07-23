-- Secondary signup step. After creating an account the user
-- lands on a preferences screen (username + timezone, both prefilled) and
-- presses "Finish Signup". NULL = the account exists but hasn't completed
-- that step yet, so the app routes it back to /welcome until it does.
-- Existing accounts predate the step and must never see it: backfill them
-- as onboarded at their creation time.

ALTER TABLE users ADD COLUMN onboarded_at TEXT;  -- ISO 8601 UTC; set once by POST /auth/onboarding
UPDATE users SET onboarded_at = created_at;
