// App-level rate limiting for the auth endpoints: a D1
// sliding window in the spirit of the comment route's — count recent rows,
// refuse past the cap — but on a dedicated auth_attempts table, because a
// failed login or refused signup leaves no natural row behind the way a
// posted comment does. Keys are composite bucket strings ("login:ip:1.2.3.4",
// "login:id:user@example.com") so one table serves every window.
//
// Lockouts are time-bounded by design: requests refused with a 429 are NOT
// recorded, so hammering an identifier can't stretch its window forever —
// service resumes at most windowMs after the last *counted* attempt, and a
// successful login clears the identifier's failures outright.

export interface WindowRule {
  key: string;
  limit: number; // counted attempts allowed per window
  windowMs: number;
}

export async function isRateLimited(db: D1Database, rules: WindowRule[]): Promise<boolean> {
  const counts = await db.batch<{ n: number }>(
    rules.map((r) =>
      db
        .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE rl_key = ?1 AND created_at > ?2")
        .bind(r.key, new Date(Date.now() - r.windowMs).toISOString())
    )
  );
  return counts.some((res, i) => (res.results[0]?.n ?? 0) >= rules[i].limit);
}

// Counted rows are dead weight once the longest window has passed; sweeping
// them here, on the (already rate-limited) write path, keeps the table
// bounded without leaning on the nightly cron.
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

export async function recordAttempt(db: D1Database, keys: string[]): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    ...keys.map((k) => db.prepare("INSERT INTO auth_attempts (rl_key, created_at) VALUES (?1, ?2)").bind(k, now)),
    db.prepare("DELETE FROM auth_attempts WHERE created_at < ?1").bind(new Date(Date.now() - PRUNE_AFTER_MS).toISOString()),
  ]);
}

export async function clearAttempts(db: D1Database, keys: string[]): Promise<void> {
  await db.batch(keys.map((k) => db.prepare("DELETE FROM auth_attempts WHERE rl_key = ?1").bind(k)));
}
