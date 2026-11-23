import { ACCOUNT_USERNAME_RE } from '@outpost/shared/api';
import { describe, expect, it } from 'vitest';
import { maskSecret } from '../src/auth/admin.ts';
import { usernameSchema } from '../src/auth/accounts.ts';
import {
  dummyPasswordHash,
  hashPassword,
  maxmemFor,
  needsRehash,
  parsePasswordHash,
  passwordSchema,
  SCRYPT_LIMITS,
  verifyPassword,
} from '../src/auth/password.ts';
import { accountClientKey, accountKey, clientKey, FailureThrottle, reauthKey, throttledError } from '../src/auth/throttle.ts';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  normaliseTotpCode,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from '../src/auth/totp.ts';
import { HttpError } from '../src/http/errors.ts';

describe('password hashing (scrypt)', () => {
  it('produces a self-describing hash with the PLAN §10 parameters and a per-user salt', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(a).not.toBe(b);
    const parsed = parsePasswordHash(a)!;
    expect(parsed).toMatchObject({ ln: 15, r: 8, p: 1 });
    expect(parsed.salt.length).toBe(16);
    expect(parsed.key.length).toBe(64);
    expect(needsRehash(a)).toBe(false);
  });

  it('verifies the right password and rejects others', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', h)).toBe(true);
    expect(await verifyPassword('s3cret-pasS', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('normalises Unicode (NFKC) so composed and decomposed input match', async () => {
    const composed = 'café-pass';
    const decomposed = 'café-pass';
    const h = await hashPassword(composed);
    expect(await verifyPassword(decomposed, h)).toBe(true);
  });

  it('never throws for malformed or hostile stored hashes', async () => {
    for (const bad of [
      '',
      'test-hash',
      '$scrypt$ln=15,r=8,p=1$$',
      '$scrypt$ln=40,r=8,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5a2V5',
      '$scrypt$ln=15,r=999,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5a2V5',
      '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
      expect(parsePasswordHash(bad)).toBeNull();
      expect(needsRehash(bad)).toBe(true);
    }
  });

  it('bounds the scrypt memory a stored hash can ask for (256 MiB at most)', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
    const key = Buffer.alloc(64, 2).toString('base64').replace(/=+$/, '');
    const enc = (ln: number, r: number, p: number) => `$scrypt$ln=${ln},r=${r},p=${p}$${salt}$${key}`;
    // The worst accepted combination stays within 256 MiB of scrypt memory (plus slack).
    expect(parsePasswordHash(enc(SCRYPT_LIMITS.ln, SCRYPT_LIMITS.r, SCRYPT_LIMITS.p))).not.toBeNull();
    expect(128 * 2 ** SCRYPT_LIMITS.ln * SCRYPT_LIMITS.r).toBe(256 * 1024 * 1024);
    expect(maxmemFor(2 ** SCRYPT_LIMITS.ln, SCRYPT_LIMITS.r, SCRYPT_LIMITS.p)).toBeLessThan(258 * 1024 * 1024);
    // Anything above a bound is not a valid hash (formerly ln=20, r=32 meant 4 GiB per sign-in).
    for (const [ln, r, p] of [
      [SCRYPT_LIMITS.ln + 1, 8, 1],
      [15, SCRYPT_LIMITS.r + 1, 1],
      [15, 8, SCRYPT_LIMITS.p + 1],
      [20, 32, 1],
    ] as const) {
      expect(parsePasswordHash(enc(ln, r, p)), `${ln}/${r}/${p}`).toBeNull();
      expect(await verifyPassword('anything', enc(ln, r, p))).toBe(false);
    }
    // The default parameters need more than Node's 32 MiB default maxmem; maxmemFor allows it.
    expect(maxmemFor(2 ** 15, 8, 1)).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('flags weaker stored parameters for rehashing', () => {
    const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
    const key = Buffer.alloc(64, 2).toString('base64').replace(/=+$/, '');
    expect(needsRehash(`$scrypt$ln=14,r=8,p=1$${salt}$${key}`)).toBe(true);
    expect(needsRehash(`$scrypt$ln=15,r=8,p=1$${salt}$${key}`)).toBe(false);
  });

  it('caches one dummy hash for unknown users', async () => {
    const a = await dummyPasswordHash();
    expect(a).toBe(await dummyPasswordHash());
    expect(parsePasswordHash(a)).not.toBeNull();
  });

  it('enforces length limits on new passwords', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('        ').success).toBe(false);
    expect(passwordSchema.safeParse('long enough').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(256)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(257)).success).toBe(false);
  });
});

describe('usernames', () => {
  it('follows ACCOUNT_USERNAME_RE (2–30 chars, letters/digits/_/-, no leading symbol)', () => {
    for (const ok of ['ab', 'Magnus', 'chess_fan-99', '9lives', 'a'.repeat(30)]) {
      expect(usernameSchema.safeParse(ok).success, ok).toBe(true);
      expect(ACCOUNT_USERNAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ['a', '_lead', '-lead', 'has space', 'émile', 'a'.repeat(31), 'semi;colon', '']) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(usernameSchema.parse('  trimmed ')).toBe('trimmed');
  });
});

describe('TOTP (RFC 4226 / RFC 6238)', () => {
  const rfcKey = Buffer.from('12345678901234567890', 'ascii');

  it('matches the RFC 4226 Appendix D HOTP values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(rfcKey, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    const secret = base32Encode(rfcKey);
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [t, code] of vectors) expect(totpCode(secret, t * 1000)).toBe(code);
  });

  it('round-trips base32 and rejects invalid input', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI')!.toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi======')!.toString()).toBe('foobar');
    expect(base32Decode('not base32!')).toBeNull();
    expect(base32Decode('')).toBeNull();
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)!.length).toBe(20);
  });

  it('accepts the current step ±1 and nothing further', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 23, 12, 0, 15);
    const step = totpStep(now);
    for (const d of [-1, 0, 1]) {
      expect(verifyTotp(secret, totpCode(secret, now + d * 30_000), { nowMs: now })).toBe(step + d);
    }
    for (const d of [-3, -2, 2, 3]) {
      expect(verifyTotp(secret, totpCode(secret, now + d * 30_000), { nowMs: now })).toBeNull();
    }
  });

  it('refuses a step at or before the last accepted one (no replay)', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 23, 12, 0, 15);
    const step = totpStep(now);
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, { nowMs: now, lastStep: step - 1 })).toBe(step);
    expect(verifyTotp(secret, code, { nowMs: now, lastStep: step })).toBeNull();
    // An older (still in-window) code after a newer one was used: refused too.
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), { nowMs: now, lastStep: step })).toBeNull();
  });

  it('normalises pasted codes and rejects junk', () => {
    expect(normaliseTotpCode('123 456')).toBe('123456');
    expect(normaliseTotpCode('123-456')).toBe('123456');
    expect(normaliseTotpCode('12345')).toBeNull();
    expect(normaliseTotpCode('abcdef')).toBeNull();
    expect(verifyTotp(generateTotpSecret(), 'abcdef')).toBeNull();
    expect(verifyTotp('!!!', '123456')).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const u = new URL(otpauthUrl('JBSWY3DPEHPK3PXP', 'Alice Smith'));
    expect(u.protocol).toBe('otpauth:');
    expect(u.host).toBe('totp');
    expect(decodeURIComponent(u.pathname)).toBe('/Outpost:Alice Smith');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Outpost',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});

describe('FailureThrottle', () => {
  it('blocks a key after max failures inside the window and frees it as failures age out', () => {
    let now = 1_000_000;
    const t = new FailureThrottle({ max: 3, windowMs: 60_000, now: () => now });
    t.fail('a');
    now += 10_000;
    t.fail('a');
    expect(t.blockedUntil('a')).toBeNull();
    now += 10_000;
    t.fail('a');
    expect(t.blockedUntil('a')).toBe(1_000_000 + 60_000);
    expect(t.blockedUntil('b')).toBeNull();
    expect(() => t.assertAllowed('a')).toThrow(HttpError);
    now = 1_000_000 + 60_001;
    expect(t.blockedUntil('a')).toBeNull();
    t.assertAllowed('a');
  });

  it('reset clears a key; the number of keys is capped', () => {
    const t = new FailureThrottle({ max: 2, windowMs: 60_000, maxKeys: 3 });
    t.fail('a');
    t.fail('a');
    expect(t.blockedUntil('a')).not.toBeNull();
    t.reset('a');
    expect(t.blockedUntil('a')).toBeNull();
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) t.fail(k);
    expect(t.size).toBe(3);
  });

  it('keys clients like @fastify/rate-limit: IPv4-mapped as IPv4, IPv6 by /64', () => {
    expect(clientKey('203.0.113.7')).toBe('ip:203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb::9'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey(undefined)).toBe('ip:unknown');
    expect(accountKey('  Alice ')).toBe('user:alice');
    expect(accountClientKey('ALICE', '203.0.113.7')).toBe('user:alice|ip:203.0.113.7');
    expect(accountClientKey('alice', '203.0.113.7')).not.toBe(accountClientKey('alice', '203.0.113.8'));
    expect(reauthKey(7)).toBe('uid:7');
  });

  it('throttledError carries retry info', () => {
    const e = throttledError(10_500, 'Too many', 1_000);
    expect(e.statusCode).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.details).toEqual({ retryAt: 10_500, retryAfterSec: 10 });
    expect(e.message).toBe('Too many; try again in 10 seconds');
  });
});

describe('maskSecret', () => {
  it('shows a recognisable prefix and the last 4 characters only', () => {
    expect(maskSecret('lip_abcdefghijklmnopqrstuvwxyz1234')).toBe('lip_…1234');
    expect(maskSecret('ABCDEFGHIJKLMNOP')).toBe('AB…MNOP');
    expect(maskSecret('short')).toBe('…');
  });
});
