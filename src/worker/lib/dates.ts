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

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
