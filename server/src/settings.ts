/**
 * Instance settings (PLAN §6 admin settings), stored as JSON values in `instance_settings`.
 *
 * Read them with `readSettings(db, config)`: stored values over defaults, with the env vars
 * LICHESS_TOKEN and CHESSCOM_CONTACT winning over the stored ones (PLAN §3). Invalid stored
 * values fall back to the default. The admin module writes them with `writeSettings`.
 */
import type { MastersSource, SignupMode } from '@outpost/shared/api';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';

/** All instance settings with their effective values. */
export interface InstanceSettings {
  signupMode: SignupMode;
  anonymousBrowsing: boolean;
  /** Effective Lichess token (env wins), or null. Never send it to the browser. */
  lichessToken: string | null;
  /** Effective Chess.com contact (env wins), or null. */
  chesscomContact: string | null;
  autoRefreshHourUtc: number;
  updateCooldownMinutes: number;
  /** 0 = import everything. */
  initialSyncMonths: number;
  mastersSource: MastersSource;
}

/** Defaults for a fresh instance. */
export const DEFAULT_SETTINGS: Readonly<InstanceSettings> = {
  signupMode: 'closed',
  anonymousBrowsing: false,
  lichessToken: null,
  chesscomContact: null,
  autoRefreshHourUtc: 9,
  updateCooldownMinutes: 15,
  initialSyncMonths: 0,
  mastersSource: 'lichess',
};

/** Validators for stored values, one per key. */
export const SETTING_SCHEMAS = {
  signupMode: z.enum(['closed', 'invite', 'open']),
  anonymousBrowsing: z.boolean(),
  lichessToken: z.string().regex(/^[A-Za-z0-9_]+$/).max(2048).nullable(),
  chesscomContact: z.string().trim().min(1).max(200).nullable(),
  autoRefreshHourUtc: z.number().int().min(0).max(23),
  updateCooldownMinutes: z.number().int().min(0).max(7 * 24 * 60),
  initialSyncMonths: z.number().int().min(0).max(600),
  mastersSource: z.custom<MastersSource>(v => typeof v === 'string' && /^(lichess|reference:[1-9]\d*)$/.test(v)),
} satisfies { [K in keyof InstanceSettings]: z.ZodType<InstanceSettings[K]> };

type Key = keyof InstanceSettings;
const KEYS = Object.keys(DEFAULT_SETTINGS) as Key[];

/** Stored values only (validated; invalid or unknown keys are skipped). */
export function readStoredSettings(db: Db): Partial<InstanceSettings> {
  const out: Partial<Record<Key, unknown>> = {};
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM instance_settings')) {
    if (!(KEYS as string[]).includes(row.key)) continue;
    const key = row.key as Key;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const r = SETTING_SCHEMAS[key].safeParse(parsed);
    if (r.success) out[key] = r.data;
  }
  return out as Partial<InstanceSettings>;
}

/** Effective settings: defaults ← stored ← env overrides. */
export function readSettings(db: Db, config: Config): InstanceSettings {
  const s: InstanceSettings = { ...DEFAULT_SETTINGS, ...readStoredSettings(db) };
  if (config.lichessToken) s.lichessToken = config.lichessToken;
  if (config.chesscomContact) s.chesscomContact = config.chesscomContact;
  return s;
}

/** Writes a subset of settings (validated). `null` for a nullable key stores null. */
export function writeSettings(db: Db, patch: Partial<InstanceSettings>): void {
  db.tx(() => {
    for (const key of KEYS) {
      if (!(key in patch)) continue;
      const value = SETTING_SCHEMAS[key].parse(patch[key]);
      db.run(
        'INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      );
    }
  });
}

/** `Outpost/<version> (self-hosted; contact: <contact>)` — the User-Agent for Chess.com and Lichess (PLAN §3). */
export function userAgent(version: string, contact: string | null): string {
  return contact ? `Outpost/${version} (self-hosted; contact: ${contact})` : `Outpost/${version} (self-hosted)`;
}
