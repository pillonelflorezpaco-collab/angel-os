import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Passphrase hashing for the single-owner sign-in. scrypt (memory-hard), per-hash random salt, constant-time compare.
// Stored as: scrypt$N$r$p$<salt b64>$<hash b64>. A malformed stored value never verifies (fail closed).

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32, MAXMEM = 128 * N * R * 2;
export const MIN_PASSPHRASE_CHARS = 12;

const derive = (pass: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pass.normalize("NFKC"), salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 } as ScryptOptions, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassphrase(pass: string): Promise<string> {
  if (pass.length < MIN_PASSPHRASE_CHARS) throw new Error(`Use at least ${MIN_PASSPHRASE_CHARS} characters.`);
  const salt = randomBytes(16);
  const key = await derive(pass, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassphrase(pass: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    const [nn, rr, pp] = [Number(n), Number(r), Number(p)];
    if (![nn, rr, pp].every((v) => Number.isInteger(v) && v > 0) || nn > 2 ** 20 || rr > 32 || pp > 16) return false;
    const expected = Buffer.from(hash, "base64");
    if (expected.length < 16 || expected.length > 128) return false;
    const actual = await derive(pass, Buffer.from(salt, "base64"), nn, rr, pp, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
export { MAXMEM };
