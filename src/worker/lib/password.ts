// PBKDF2 via WebCrypto — native on Workers, fits the free-plan CPU budget
// where WASM argon2/bcrypt would not. Only login/register pay this cost.

const ITERATIONS = 100_000;
const KEY_BYTES = 32;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${b64(salt)}:${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iters, saltB64, hashB64] = stored.split(":");
  if (scheme !== "pbkdf2") return false;
  const expected = unb64(hashB64);
  const actual = await derive(password, unb64(saltB64), Number(iters));
  return crypto.subtle.timingSafeEqual(actual as BufferSource, expected as BufferSource);
}
