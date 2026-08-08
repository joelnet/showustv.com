// Storage/transfer is UTC ISO 8601; air dates are date-only 'YYYY-MM-DD'.
// "Has this episode aired?" is judged against today's date in the user's
// profile timezone (IANA name from the session).

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayInTz(tz: string): string {
  // en-CA locale formats as YYYY-MM-DD.
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// The calendar date `days` before today in the user's tz, as 'YYYY-MM-DD'.
// Used as the cutoff for "recent activity" windows; whole-day arithmetic in
// UTC is precise enough for a multi-week window.
export function daysAgoInTz(tz: string, days: number): string {
  const t = Date.parse(todayInTz(tz) + "T00:00:00Z");
  return new Date(t - days * 86400000).toISOString().slice(0, 10);
}

// Minutes past local midnight right now in tz (0..1439). Pairs with
// users.notify_min for the episode-alert cron's "has this user's delivery
// time passed yet today?" check. Falls back to UTC minutes on a bad tz,
// matching todayInTz's fallback so both always describe the same clock.
export function localMinutesInTz(tz: string): number {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return get("hour") * 60 + get("minute");
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
