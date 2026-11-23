/**
 * Shared helpers of the explorer tests (explorer-*.test.ts): fixture loading, Lichess shape
 * comparison, NDJSON parsing as lila does it, and small seeding helpers.
 */
import { readFileSync } from 'node:fs';
import type { Id } from '@outpost/shared/api';
import { expect } from 'vitest';
import type { Db } from '../src/db/index.ts';

const FIXTURES = new URL('./fixtures/explorer/', import.meta.url);

/** A fixture file's text. */
export const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Parses NDJSON exactly like lila's `readNdJson`: every non-empty line, the last one wins. */
export function lastNdjsonLine<T = unknown>(text: string): T {
  const lines = text.split(/\r?\n/).filter(l => l !== '');
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as T;
}

type Shape = 'null' | 'number' | 'string' | 'boolean' | Shape[] | { [k: string]: Shape };

const shapeOf = (v: unknown): Shape => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v as 'number' | 'string' | 'boolean';
};

/**
 * Asserts that `actual` has every key of `sample` with the same JSON type, recursively (array items
 * compared with the sample's first item). `nullable` paths may be null or an object on either side
 * (e.g. `moves[].game`), `optional` keys may be absent from `actual`.
 */
export function expectSameShape(
  actual: unknown,
  sample: unknown,
  opts: { nullable?: string[]; optional?: string[]; path?: string } = {},
): void {
  const path = opts.path ?? '$';
  const leaf = path.replace(/\[\]/g, '').split('.').pop() ?? '';
  if (sample === null || actual === null) {
    if (sample === actual) return;
    if (opts.nullable?.includes(leaf)) {
      if (sample !== null && actual === null) return;
      if (sample === null) return; // can't compare further
    }
    expect.fail(`${path}: expected ${JSON.stringify(shapeOf(sample))}, got ${JSON.stringify(shapeOf(actual))}`);
  }
  if (Array.isArray(sample)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    const items = actual as unknown[];
    if (sample.length && items.length) for (const item of items) expectSameShape(item, sample[0], { ...opts, path: `${path}[]` });
    return;
  }
  if (typeof sample === 'object') {
    expect(typeof actual, `${path} should be an object`).toBe('object');
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      const a = (actual as Record<string, unknown>)[k];
      if (a === undefined) {
        if (opts.optional?.includes(k)) continue;
        expect.fail(`${path}.${k} is missing`);
      }
      expectSameShape(a, v, { ...opts, path: `${path}.${k}` });
    }
    return;
  }
  expect(typeof actual, `${path} should be a ${typeof sample}`).toBe(typeof sample);
}

/** Inserts a profile with sources; returns its id. */
export function createProfile(
  db: Db,
  p: { slug: string; ownerId: Id | null; visibility?: 'public' | 'private'; sources: Array<{ id: Id; hidden?: boolean }> },
): Id {
  const now = Date.now();
  const id = db.run(
    'INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [p.slug, p.slug, p.ownerId, p.visibility ?? 'public', now, now],
  ).lastInsertRowid;
  for (const s of p.sources) {
    db.run('INSERT INTO profile_sources (profile_id, source_id, hidden) VALUES (?, ?, ?)', [id, s.id, s.hidden ?? false]);
  }
  return id;
}

/** Inserts a database (reference ones public, as the reference module creates them; others private); returns its id. */
export function createDatabase(
  db: Db,
  d: { name: string; kind: 'games' | 'reference'; ownerId?: Id | null; visibility?: 'public' | 'private' },
): Id {
  return db.run('INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, ?, ?, ?, ?)', [
    d.ownerId ?? null,
    d.name,
    d.kind,
    d.visibility ?? (d.kind === 'reference' ? 'public' : 'private'),
    Date.now(),
  ]).lastInsertRowid;
}

/** SAN moves of a UCI-free line, split from a string like "e4 e5 Nf3". */
export const sans = (s: string): string[] => s.trim().split(/\s+/);
