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
