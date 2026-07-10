// Display rules: dates/times shown to the user render in their profile
// timezone, 12-hour clock with AM/PM. Air dates are date-only and must not
// shift across timezones, so they format in UTC from their literal parts.

function dateOnlyUTC(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function todayStr(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// Air-date column for an episode row. The server's `aired` flag classifies
// undated episodes (see worker lib/aired.ts): a date gap on an episode that
// has aired reads "Unknown", while a genuinely unaired one stays "TBA".
export function fmtEpisodeDate(d: string | null, aired: boolean, tz: string): string {
  if (!d) return aired ? "Unknown" : "TBA";
  return fmtAirDate(d, tz);
}

// Compact calendar date for pills (issue #175): short month + day with no
// leading zero, e.g. "Jan 17", "Feb 3". Date-only input, so like fmtAirDate
// it formats in UTC from the literal parts and never shifts across timezones.
export function fmtMonthDay(d: string): string {
  return dateOnlyUTC(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

export function fmtAirDate(d: string | null, tz: string): string {
  if (!d) return "TBA";
  const today = todayStr(tz);
  if (d === today) return "Today";
  const tomorrow = new Date(dateOnlyUTC(today).getTime() + 86400_000).toISOString().slice(0, 10);
  if (d === tomorrow) return "Tomorrow";
  const opts: Intl.DateTimeFormatOptions = { timeZone: "UTC", month: "short", day: "numeric" };
  if (d.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return dateOnlyUTC(d).toLocaleDateString("en-US", opts);
}

// Full timestamps (watched_at etc.): user tz, 12-hour AM/PM.
export function fmtDateTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Reddit-style relative timestamps for comments. Coarse on purpose; pair
// with a full fmtDateTime in the title attribute for the exact moment.
export function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function epCode(season: number, number: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `S${pad(season)}·E${pad(number)}`;
}

export function runtimeStr(min: number | null): string {
  if (!min) return "";
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

// Accumulated watch time, friendly-form: the two largest non-zero units,
// e.g. "3 months 4 days" or "6 hours 12 minutes". Months are 30 days.
export function watchTimeStr(min: number): string {
  if (min <= 0) return "0 minutes";
  const units: [string, number][] = [
    ["month", 30 * 24 * 60],
    ["day", 24 * 60],
    ["hour", 60],
    ["minute", 1],
  ];
  const parts: string[] = [];
  let rest = Math.round(min);
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    } else if (parts.length) break; // stop at first gap so units stay adjacent
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}
