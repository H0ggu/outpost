/**
 * TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps — what every
 * authenticator app expects by default.
 *
 * - Codes are accepted for the current step ±1 (clock drift).
 * - A code is accepted only for a step strictly greater than the user's last accepted step
 *   (`users.totp_last_step`), so a code cannot be replayed, not even within its own window.
 *   Callers record the step atomically (`UPDATE … WHERE totp_last_step < ?`).
 * - Secrets are 20 random bytes (160 bits, RFC 4226 §4), stored and shown as unpadded base32.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Seconds per time step. */
export const TOTP_PERIOD_SEC = 30;
/** Digits per code. */
export const TOTP_DIGITS = 6;
/** Accepted drift, in steps, on each side of the current one. */
export const TOTP_WINDOW = 1;
/** Secret length in bytes. */
export const TOTP_SECRET_BYTES = 20;
/** A pending secret from `/api/me/totp/setup` must be confirmed within this time. */
export const TOTP_PENDING_TTL_MS = 30 * 60 * 1000;
/** Issuer shown in authenticator apps. */
export const TOTP_ISSUER = 'Outpost';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 (case-insensitive, spaces and padding ignored); null when invalid. */
export function base32Decode(s: string): Buffer | null {
  const clean = s.replace(/[\s=]/g, '').toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (base32). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(TOTP_SECRET_BYTES));

/** The time step for `nowMs`. */
export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);

/** HOTP value (RFC 4226 §5.3) for a counter, zero-padded to `TOTP_DIGITS`. */
export function hotp(key: Uint8Array, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The code for a base32 secret at `nowMs` (tests, and nothing else on the server). */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('invalid TOTP secret');
  return hotp(key, totpStep(nowMs));
}

/** Strips spaces and dashes users paste from apps ("123 456"); null unless exactly 6 digits remain. */
export function normaliseTotpCode(code: string): string | null {
  const c = code.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

/**
 * Checks `code` against `secret` at `nowMs` (±`TOTP_WINDOW` steps). Returns the matching step when
 * it is newer than `lastStep`, else null. Every candidate step is computed and compared in constant
 * time, so the timing does not reveal which step (if any) matched.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { nowMs?: number; lastStep?: number | null } = {},
): number | null {
  const key = base32Decode(secret);
  const c = normaliseTotpCode(code);
  if (!key || !c) return null;
  const current = totpStep(opts.nowMs ?? Date.now());
  const given = Buffer.from(c, 'utf8');
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, step), 'utf8'), given);
    if (ok && (matched === null || step > matched)) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastStep !== null && opts.lastStep !== undefined && matched <= opts.lastStep) return null;
  return matched;
}

/** `otpauth://totp/<issuer>:<account>?secret=…&issuer=…` (Key Uri Format used by authenticator apps). */
export function otpauthUrl(secret: string, account: string, issuer: string = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
