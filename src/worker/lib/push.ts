// Web Push delivery (issue #129) via @block65/webcrypto-web-push — VAPID
// signing and payload encryption on pure WebCrypto, so it runs on the plain
// Workers runtime (the usual `web-push` package needs Node built-ins /
// nodejs_compat). The library builds the encrypted body + headers; we POST
// them to the subscription endpoint ourselves.
//
// Keys are optional on purpose: until a human generates VAPID keys and sets
// the secrets (see wrangler.jsonc), vapidConfigured() is false, senders skip
// push entirely, and the app is in-app-notifications-only. Push is always
// best-effort — a failed send never fails the request that triggered it.

import { buildPushPayload, type PushMessage, type PushSubscription } from "@block65/webcrypto-web-push";
import type { Env } from "../env";

// A push_subscriptions row, as stored by routes/notifications.ts.
export interface StoredSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// What the service worker's `push` handler expects (event.data.json()).
// A type alias (not an interface) so it satisfies the library's Jsonifiable
// constraint — interfaces lack the implicit index signature that needs.
export type PushData = {
  title: string;
  body: string;
  url: string; // same-origin path the notification click opens
  tag?: string; // same tag replaces the previous notification instead of stacking
  unread?: number; // recipient's unread count at send time — the SW mirrors it onto the app icon (issue #142)
};

export function vapidConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

// Send one push. "gone" means the push service reports the subscription dead
// (404/410) and the caller should prune the row; other failures are logged
// and swallowed.
export async function sendPush(env: Env, sub: StoredSubscription, data: PushData): Promise<"ok" | "gone" | "failed"> {
  const subscription: PushSubscription = {
    endpoint: sub.endpoint,
    expirationTime: null,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  // ttl: how long the push service holds the message for an offline device.
  // A day covers "phone in a drawer overnight" without replaying stale news.
  const message: PushMessage = { data, options: { ttl: 24 * 3600, ...(data.tag ? { topic: safeTopic(data.tag) } : {}) } };
  try {
    const payload = await buildPushPayload(message, subscription, {
      subject: env.VAPID_SUBJECT ?? "https://showustv.com",
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    const res = await fetch(sub.endpoint, payload);
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) {
      console.error(`push: HTTP ${res.status} from ${new URL(sub.endpoint).hostname}`);
      return "failed";
    }
    return "ok";
  } catch (e) {
    console.error("push: send failed", e);
    return "failed";
  }
}

// RFC 8030 Topic header: at most 32 characters from the base64url alphabet.
// Collapses queued-but-undelivered pushes for the same event at the push
// service, mirroring the notification `tag` collapsing on the device.
function safeTopic(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
}
