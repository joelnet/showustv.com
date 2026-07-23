// PBKDF2 via WebCrypto — native on Workers, fits the CPU budget where WASM
// argon2/bcrypt would not. Only login/register pay this cost.
//
// Work factor: 600,000 iterations — OWASP's current recommendation
// for PBKDF2-HMAC-SHA256. The count is stored IN every hash
// (`pbkdf2:<iters>:<salt>:<hash>`), so verifyPassword derives with each
// record's OWN embedded count: legacy 100k hashes keep verifying unchanged (no
// mass invalidation, no migration), and are transparently re-hashed to
// ITERATIONS the next time their owner logs in (see needsRehash +
// rehash-on-login in routes/auth.ts). New registrations and password resets get
// ITERATIONS straight away. The added per-verify CPU is bounded — a single
// derive is well under the Workers paid-plan CPU limit (30s default) — and auth
// is rate-limited with the password length capped before any hashing,
// so the raised factor can't be turned into a CPU-DoS amplifier.

const ITERATIONS = 600_000;
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

// True when a stored hash was made with FEWER iterations than we now use, so a
// caller that has just successfully verified it (login) can re-derive at
// ITERATIONS and update the record in place. Records already at (or
// above) the current factor — and the not-found dummy, which is regenerated at
// ITERATIONS — return false and do no extra work. Non-pbkdf2 records can't be
// verified anyway (verifyPassword returns false), so they never reach here.
export function needsRehash(stored: string): boolean {
  const [scheme, iters] = stored.split(":");
  return scheme === "pbkdf2" && Number(iters) < ITERATIONS;
}

// A real PBKDF2 record (at ITERATIONS) for a random password nobody knows (32
// random bytes, discarded after hashing — this verify can only return false).
// Login checks against this when the account does NOT exist, so the not-found
// branch costs the same 600k iterations as a real check and response timing
// stops leaking which emails/usernames are registered. Regenerate
// it whenever ITERATIONS changes so the nonexistent-account path keeps matching
// a real verify at the new factor.
export const DUMMY_PW_HASH = "pbkdf2:600000:XPrp4dQTkKSBgXwo89pT/A==:3ddXiMjufTR2PbND1TUVLQThwx8bZi7LBi+rbrHkcwk=";

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iters, saltB64, hashB64] = stored.split(":");
  if (scheme !== "pbkdf2") return false;
  const storedIters = Number(iters);
  const salt = unb64(saltB64);
  const expected = unb64(hashB64);
  const actual = await derive(password, salt, storedIters);
  // Keep EVERY verify at the same PBKDF2 cost. Raising the
  // factor to 600k left older 100k records cheaper to check, so a failed login
  // against an un-upgraded legacy account would be measurably faster than one
  // against the 600k not-found DUMMY — reopening the "does this account exist"
  // timing oracle the auth rate-limit work closed, for accounts that predate the bump and haven't
  // logged in since. Pad any sub-factor record up to ITERATIONS with a throwaway
  // derive so legacy, current, and not-found verifies all cost ~600k. (This
  // flattens ONLINE timing only; the stored hash's offline strength is what
  // rehash-on-login upgrades.)
  if (storedIters < ITERATIONS) await derive(password, salt, ITERATIONS - storedIters);
  return crypto.subtle.timingSafeEqual(actual as BufferSource, expected as BufferSource);
}
