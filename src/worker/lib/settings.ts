// Global app settings (app_settings key/value table). Currently just the
// site-open switch that gates the wait list (issue #26).
import type { Env } from "../env";

export async function isSiteOpen(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'site_open'").first<{ value: string }>();
  return row?.value === "1";
}

export async function setSiteOpen(env: Env, open: boolean): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('site_open', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1"
  )
    .bind(open ? "1" : "0")
    .run();
}
