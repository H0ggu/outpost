/**
 * Environment configuration (PLAN §3), validated with zod.
 *
 * Relative paths (DATA_DIR) resolve against the repository root — the folder that holds
 * server/, web/ and shared/ — so `npm run dev`, `node server/src/main.ts` and Docker agree
 * regardless of the working directory. Empty env values count as unset.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repository root (absolute, trailing separator removed). */
export const ROOT_DIR: string = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const serverPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
/** Outpost version (server/package.json). */
export const VERSION: string = serverPkg.version;

/** Pino log levels accepted by LOG_LEVEL. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** Log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Named address ranges understood by Fastify's `trustProxy` (proxy-addr). */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const isProxyEntry = (s: string): boolean => {
  if (NAMED_RANGES.has(s)) return true;
  const [ip, bits, extra] = s.split('/');
  if (extra !== undefined || !ip) return false;
  const v = isIP(ip);
  if (v === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v === 4 ? 32 : 128);
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_ORIGIN: z
    .string()
    .transform((s, ctx) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must be a URL like https://chess.example.com' });
        return z.NEVER;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must use http or https' });
        return z.NEVER;
      }
      if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) {
        ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must be an origin only (no path, query or credentials)' });
        return z.NEVER;
      }
      return u.origin;
    })
    .optional(),
  TRUSTED_PROXIES: z
    .string()
    .default('')
    .transform((s, ctx): boolean | string[] => {
      const t = s.trim();
      if (t === '' || t === 'false') return false;
      if (t === 'true' || t === '*') return true;
      const list = t.split(',').map(x => x.trim()).filter(Boolean);
      const bad = list.filter(x => !isProxyEntry(x));
      if (bad.length) {
        ctx.addIssue({ code: 'custom', message: `TRUSTED_PROXIES: not an IP, CIDR or named range: ${bad.join(', ')}` });
        return z.NEVER;
      }
      return list;
    }),
  DATA_DIR: z.string().min(1).default('./data'),
  LICHESS_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/, 'LICHESS_TOKEN may only contain letters, digits and _')
    .max(2048)
    .optional(),
  CHESSCOM_CONTACT: z.string().trim().min(1).max(200).optional(),
  SETUP_TOKEN: z.string().min(16, 'SETUP_TOKEN must be at least 16 characters').max(256).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/** Resolved, validated configuration. */
export interface Config {
  env: 'development' | 'production' | 'test';
  isProduction: boolean;
  version: string;
  host: string;
  port: number;
  /** Normalised origin (`https://chess.example.com`), or null in dev when unset. */
  publicOrigin: string | null;
  /** Mark the session cookie Secure (PUBLIC_ORIGIN is https). */
  secureCookies: boolean;
  /** Passed to Fastify `trustProxy`: false, true, or a list of IPs / CIDRs / named ranges. */
  trustProxy: boolean | string[];
  rootDir: string;
  /** Absolute DATA_DIR. */
  dataDir: string;
  /** `${dataDir}/outpost.db`. */
  dbPath: string;
  /** `${dataDir}/nnue`: cached Stockfish networks. */
  nnueDir: string;
  /** `${dataDir}/uploads`: PGN uploads and reference imports in flight. */
  uploadsDir: string;
  /** lichess-org/chess-openings TSVs (server/data/openings). */
  openingsDir: string;
  /** Built web app (web/dist); served when it exists. */
  webDistDir: string;
  /** Env LICHESS_TOKEN (wins over the admin UI value). */
  lichessToken: string | null;
  /** Env CHESSCOM_CONTACT (wins over the admin UI value). */
  chesscomContact: string | null;
  /** Env SETUP_TOKEN; when null the auth module generates one and logs it. */
  setupToken: string | null;
  logLevel: LogLevel;
}

/** Thrown when the environment is invalid; `message` lists every problem. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates the environment. Throws `ConfigError`. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') cleaned[k] = v.trim();

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  if (isProduction && !e.PUBLIC_ORIGIN) {
    throw new ConfigError(
      'Invalid configuration:\n  - PUBLIC_ORIGIN: required in production (e.g. https://chess.example.com or http://192.168.1.10:8080)',
    );
  }

  const dataDir = isAbsolute(e.DATA_DIR) ? e.DATA_DIR : resolve(ROOT_DIR, e.DATA_DIR);
  return {
    env: e.NODE_ENV,
    isProduction,
    version: VERSION,
    host: e.HOST,
    port: e.PORT,
    publicOrigin: e.PUBLIC_ORIGIN ?? null,
    secureCookies: e.PUBLIC_ORIGIN?.startsWith('https:') ?? false,
    trustProxy: e.TRUSTED_PROXIES,
    rootDir: ROOT_DIR,
    dataDir,
    dbPath: join(dataDir, 'outpost.db'),
    nnueDir: join(dataDir, 'nnue'),
    uploadsDir: join(dataDir, 'uploads'),
    openingsDir: join(ROOT_DIR, 'server', 'data', 'openings'),
    webDistDir: join(ROOT_DIR, 'web', 'dist'),
    lichessToken: e.LICHESS_TOKEN ?? null,
    chesscomContact: e.CHESSCOM_CONTACT ?? null,
    setupToken: e.SETUP_TOKEN ?? null,
    logLevel: e.LOG_LEVEL,
  };
}
