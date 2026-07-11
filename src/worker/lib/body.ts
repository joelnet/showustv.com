import type { Context } from "hono";
import type { AppEnv } from "../env";

const MAX_BODY_BYTES = 256 * 1024;

// Reads the JSON body with a byte cap enforced BEFORE parsing so an oversized
// payload is never materialized. The body is streamed and counted in actual
// wire bytes — not decoded string length, which multibyte characters could
// undercount — and the read is cancelled the moment the cap is exceeded.
// Returns null when too large (caller responds 413); malformed JSON degrades
// to {} like the other routes.
export async function readJson(c: Context<AppEnv>): Promise<{ body: any } | null> {
  const len = Number(c.req.header("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return null;
  const reader = c.req.raw.body?.getReader();
  if (!reader) return { body: {} };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { body: {} };
  }
}
