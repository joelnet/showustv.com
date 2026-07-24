// Signup auto-follow config (issue #14). Issue #11 hard-coded
// "joelnet" as the account every new signup starts out following; the
// target now lives in app_settings (0037) so the admin panel can change it.
// Empty = feature off. routes/admin.ts reads/writes the setting;
// routes/auth.ts resolves it at signup time (autoFollowOnSignup).

export const AUTO_FOLLOW_USERNAME_KEY = "auto_follow_username";

// The admin's input, normalized: whitespace trimmed and one leading @
// stripped ("@joelnet" means joelnet). Applied on save (routes/admin.ts)
// AND on read, so a raw value that reached the DB some other way still
// resolves the same at signup.
export function normalizeAutoFollowUsername(raw: string): string {
  const t = raw.trim();
  return (t.startsWith("@") ? t.slice(1) : t).trim();
}

export async function getAutoFollowUsername(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT value FROM app_settings WHERE key = ?1")
    .bind(AUTO_FOLLOW_USERNAME_KEY)
    .first<{ value: string }>();
  return normalizeAutoFollowUsername(row?.value ?? "");
}
