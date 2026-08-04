// Once-per-visit throttle for the first-show nudge — the Search popup that
// asks a brand-new (or still-empty) account for the show they're watching.
// Two triggers share it: welcome.tsx tags its signup handoff to /search, and
// watchnext.tsx bounces an empty-library visit there. The marker keeps that
// pair from looping (dismiss the popup → tap Home → get bounced right back):
// once the popup has shown, home stays quiet for the rest of the visit.
// sessionStorage scopes it to the tab — close it and a still-empty library
// nudges again next visit — with an in-memory set as the private-mode
// fallback (storage can throw; the SPA session still remembers). Keyed per
// user like the other per-user client state, so switching accounts in one
// tab doesn't swallow the second account's nudge.

const PREFIX = "first-show-nudge:";
const nudged = new Set<number | undefined>();
const nudgeKey = (userId: number | undefined) => `${PREFIX}${userId ?? "anon"}`;

export function firstShowNudgeSeen(userId: number | undefined): boolean {
  if (nudged.has(userId)) return true;
  try {
    return sessionStorage.getItem(nudgeKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function markFirstShowNudgeSeen(userId: number | undefined) {
  nudged.add(userId);
  try {
    sessionStorage.setItem(nudgeKey(userId), "1");
  } catch {}
}

// A sign-out ends the "visit" as far as the nudge is concerned: whoever
// signs in next — the same account included — starts fresh. Logging back in
// re-offers the popup; mid-session page hops still don't.
export function resetFirstShowNudges() {
  nudged.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {}
}
