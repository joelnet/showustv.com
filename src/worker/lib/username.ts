// Username rules, shared by the profile rename (issue #23) and the
// onboarding preferences step (issue #160) so the two can never drift.
// Case-insensitive uniqueness is enforced by the users.username UNIQUE
// COLLATE NOCASE constraint; this is just the shape check.
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const USERNAME_RULES = "Username must be 3–20 letters, digits, or _";
