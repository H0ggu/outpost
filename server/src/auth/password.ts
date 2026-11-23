/**
 * Password hashing (PLAN §10): scrypt N=2^15, r=8, p=1, 64-byte key, 16-byte per-user salt.
 *
 * Stored form (`users.password_hash`) is a self-describing PHC-style string, so the cost can be
 * raised later without breaking existing hashes:
 *
 *   $scrypt$ln=15,r=8,p=1$<salt, base64 no padding>$<key, base64 no padding>
 *
 * Verification parses the parameters from the stored string (within sane bounds, so a corrupt row
 * cannot make the server allocate gigabytes) and compares with `timingSafeEqual`. Anything that is
 * not a valid encoded hash simply fails verification.
 *
 * Passwords are NFKC-normalised before hashing (NIST SP 800-63B §5.1.1.2), so the same password
 * typed on different keyboards / OSes matches.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@outpost/shared/api';
import { z } from 'zod';

/** Current cost parameters for new hashes (PLAN §10). */
export const SCRYPT_PARAMS = { ln: 15, r: 8, p: 1 } as const;
/** Derived key length in bytes. */
export const SCRYPT_KEYLEN = 64;
/** Salt length in bytes. */
export const SCRYPT_SALT_BYTES = 16;

/** Upper bounds accepted when verifying a stored hash (defence against corrupt rows). */
const MAX_LN = 20;
const MAX_R = 32;
const MAX_P = 16;

/** scrypt needs 128·N·r bytes; allow that plus headroom (Node's default maxmem of 32 MiB is exactly N=2^15,r=8). */
const maxmemFor = (n: number, r: number): number => 128 * n * r * 2 + 16 * 1024 * 1024;

const scryptAsync = (password: Buffer, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');
const unb64 = (s: string): Buffer | null => (/^[A-Za-z0-9+/]+$/.test(s) ? Buffer.from(s, 'base64') : null);

const normalise = (password: string): Buffer => Buffer.from(password.normalize('NFKC'), 'utf8');

/** Hashes a password with the current parameters. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const { ln, r, p } = SCRYPT_PARAMS;
  const N = 2 ** ln;
  const key = await scryptAsync(normalise(password), salt, SCRYPT_KEYLEN, { N, r, p, maxmem: maxmemFor(N, r) });
  return `$scrypt$ln=${ln},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
}

interface ParsedHash {
  ln: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const HASH_RE = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Parses an encoded hash; null when it is not one this module produced (or is out of bounds). */
export function parsePasswordHash(encoded: string): ParsedHash | null {
  const m = HASH_RE.exec(encoded);
  if (!m) return null;
  const ln = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (ln < 1 || ln > MAX_LN || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return null;
  const salt = unb64(m[4]!);
  const key = unb64(m[5]!);
  if (!salt || !key || salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { ln, r, p, salt, key };
}

/** Verifies `password` against an encoded hash in constant time. Never throws for bad input. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const h = parsePasswordHash(encoded);
  if (!h) return false;
  const N = 2 ** h.ln;
  let key: Buffer;
  try {
    key = await scryptAsync(normalise(password), h.salt, h.key.length, { N, r: h.r, p: h.p, maxmem: maxmemFor(N, h.r) });
  } catch {
    return false;
  }
  return timingSafeEqual(key, h.key);
}

/** True when a stored hash uses weaker parameters than `SCRYPT_PARAMS` (rehash on next login). */
export function needsRehash(encoded: string): boolean {
  const h = parsePasswordHash(encoded);
  return !h || h.ln < SCRYPT_PARAMS.ln || h.r < SCRYPT_PARAMS.r || h.p < SCRYPT_PARAMS.p || h.key.length < SCRYPT_KEYLEN;
}

let dummy: Promise<string> | null = null;

/**
 * A hash of a random password, computed once per process. Login verifies unknown usernames against
 * it so "no such user" takes as long as "wrong password" (no username enumeration by timing).
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummy;
}

/** Password policy for new passwords (setup, signup, change, admin reset). */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine(s => s.trim().length > 0, 'Password must not be blank');

/** A password field when checking an existing password (login, re-auth): only bounded, never policy-checked. */
export const anyPasswordSchema = z.string().max(PASSWORD_MAX_LENGTH * 4);
