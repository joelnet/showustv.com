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

// RFC 8030 Urgency header: "low" lets the device batch delivery (radio
// already awake / on power) — right for passive social fan-out; "normal" is
// the deliver-now default for things aimed at this specific user.
export type PushUrgency = "low" | "normal" | "high";

export function vapidConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

// The wire payload is the Declarative Web Push envelope (Push API; WebKit
// blog 16535) with the legacy flat fields alongside. Safari 18.4+ renders the
// `notification` member without ever waking the service worker — which is
// what keeps push alive on iOS after ITP evicts the SW registration — while
// Chrome/Firefox ignore `web_push` and hand the whole JSON to the SW `push`
// handler, which reads either shape. The flat copy keeps service workers
// installed before this deploy working until they update.
function toWirePayload(env: Env, data: PushData) {
  // `navigate` must be absolute. VAPID_SUBJECT doubles as the canonical
  // origin while it's an https URL (it is, in every wrangler.jsonc env).
  const subject = env.VAPID_SUBJECT ?? "";
  const origin = subject.startsWith("https://") ? subject : "https://showustv.com";
  return {
    web_push: 8030,
    notification: {
      title: data.title,
      body: data.body,
      navigate: new URL(data.url, origin).href,
      ...(data.tag ? { tag: data.tag } : {}),
      // Event time, so the OS sorts by when it happened, not when it landed.
      timestamp: Date.now(),
      // Stringified per the WebKit payload example; sets the app icon badge
      // with no JS on the declarative path.
      ...(data.unread !== undefined ? { app_badge: String(data.unread) } : {}),
    },
    ...data,
  };
}

// Send one push. "gone" means the push service reports the subscription dead
// (404/410) and the caller should prune the row; other failures are logged
// and swallowed. 429/5xx get one in-invocation retry honoring Retry-After —
// capped small because waitUntil only extends life ~30s past the response.
export async function sendPush(
  env: Env,
  sub: StoredSubscription,
  data: PushData,
  urgency: PushUrgency = "normal"
): Promise<"ok" | "gone" | "failed"> {
  const subscription: PushSubscription = {
    endpoint: sub.endpoint,
    expirationTime: null,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  // ttl: how long the push service holds the message for an offline device.
  // A day covers "phone in a drawer overnight" without replaying stale news.
  const message: PushMessage = {
    data: toWirePayload(env, data),
    options: { ttl: 24 * 3600, urgency, ...(data.tag ? { topic: safeTopic(data.tag) } : {}) },
  };
  try {
    const payload = await buildPushPayload(message, subscription, {
      subject: env.VAPID_SUBJECT ?? "https://showustv.com",
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    let res = await fetch(sub.endpoint, payload);
    if (res.status === 429 || res.status >= 500) {
      const after = Math.min(Math.max(Number(res.headers.get("retry-after")) || 2, 1), 10);
      await new Promise((resolve) => setTimeout(resolve, after * 1000));
      res = await fetch(sub.endpoint, payload);
    }
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) {
      const host = new URL(sub.endpoint).hostname;
      // 413: our payload outgrew the ~4KB Web Push cap — a code bug, never
      // the subscription's fault. 401/403: the push service rejected our
      // VAPID pairing — key/config trouble, so don't prune rows over it.
      if (res.status === 413) console.error(`push: payload too large for ${host} tag=${data.tag ?? "-"}`);
      else if (res.status === 401 || res.status === 403) console.error(`push: VAPID auth rejected (HTTP ${res.status}) by ${host}`);
      else console.error(`push: HTTP ${res.status} from ${host}`);
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
