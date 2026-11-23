import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodeFiltersSegment,
  encodeFiltersSegment,
  filtersKey,
  filtersToQuery,
  formatPlayerSpec,
  oppStrengthRange,
  parseFilters,
  parsePlayerSpec,
  resolveDateRange,
  statsQuery,
  withQuery,
  type ProfileFilters,
} from '../src/filters.ts';

describe('parseFilters', () => {
  it('parses every filter from a query', () => {
    const q = new URLSearchParams(
      'color=white&period=3m&tc=blitz,bullet&src=3,1&rated=rated&outcome=l,w&opp=eq&oppName=%20magnus%20&event=Titled&line=e2e4,c7c5&page=2',
    );
    expect(parseFilters(q)).toEqual({
      color: 'white',
      period: '3m',
      tc: ['bullet', 'blitz'],
      src: [1, 3],
      rated: 'rated',
      outcome: ['w', 'l'],
      opp: 'eq',
      oppName: 'magnus',
      event: 'Titled',
      line: ['e2e4', 'c7c5'],
    });
  });

  it('accepts records with repeated keys and drops empty values', () => {
    expect(parseFilters({ tc: ['blitz', 'rapid'], color: '', from: undefined })).toEqual({ tc: ['blitz', 'rapid'] });
  });

  it('rejects invalid values in strict mode', () => {
    expect(() => parseFilters({ color: 'green' })).toThrow(ZodError);
    expect(() => parseFilters({ tc: 'blitz,hyper' })).toThrow(ZodError);
    expect(() => parseFilters({ from: '2026-02-30' })).toThrow(ZodError);
    expect(() => parseFilters({ from: '2026-05-01', to: '2026-04-01' })).toThrow(ZodError);
    expect(() => parseFilters({ line: 'e2e4,O-O' })).toThrow(ZodError);
    expect(() => parseFilters({ src: '0' })).toThrow(ZodError);
  });

  it('keeps the valid part in lenient mode', () => {
    expect(parseFilters({ color: 'green', tc: 'blitz', from: '2026-05-01', to: '2026-04-01' }, 'lenient')).toEqual({
      tc: ['blitz'],
      from: '2026-05-01',
    });
  });

  it('lets a period win over custom dates', () => {
    expect(parseFilters({ period: '7d', from: '2026-01-01' })).toEqual({ period: '7d' });
  });
});

describe('serialisation', () => {
  const f: ProfileFilters = { outcome: ['l', 'w'], color: 'black', line: ['d2d4', 'g8f6'], src: [2, 1, 2] };

  it('writes a canonical query in stable key order', () => {
    expect(filtersToQuery(f).toString()).toBe('color=black&src=1%2C2&outcome=w%2Cl&line=d2d4%2Cg8f6');
    expect(filtersKey({})).toBe('');
  });

  it('round-trips through the query', () => {
    expect(parseFilters(filtersToQuery(f))).toEqual(parseFilters(filtersToQuery(parseFilters(filtersToQuery(f)))));
  });

  it('adds extra params with statsQuery and withQuery', () => {
    expect(statsQuery({ color: 'white' }, { page: 2, side: undefined }).toString()).toBe('color=white&page=2');
    expect(() => statsQuery({ tc: ['blitz'] }, { tc: 'rapid' })).toThrow(/filter key/);
    expect(withQuery('/api/x', { a: 1, b: null, c: ['x', 'y'] })).toBe('/api/x?a=1&c=x%2Cy');
    expect(withQuery('/api/x', {})).toBe('/api/x');
  });
});

describe('explorer path segment', () => {
  it('round-trips base64url, including non-ASCII text', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'oppName=Ørjan Ç', '???>>>']) expect(base64UrlDecode(base64UrlEncode(s))).toBe(s);
    expect(base64UrlEncode('???>>>')).not.toMatch(/[+/=]/);
    expect(() => base64UrlDecode('ab$c')).toThrow();
  });

  it('round-trips filters and uses _ for none', () => {
    const f: ProfileFilters = { color: 'white', tc: ['blitz'], oppName: 'Ørjan', line: ['e2e4'] };
    const seg = encodeFiltersSegment(f);
    expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFiltersSegment(seg)).toEqual(parseFilters(filtersToQuery(f)));
    expect(encodeFiltersSegment({})).toBe('_');
    expect(decodeFiltersSegment('_')).toEqual({});
  });

  it('rejects garbage in strict mode only', () => {
    expect(() => decodeFiltersSegment('!!')).toThrow();
    expect(decodeFiltersSegment('!!', 'lenient')).toEqual({});
    expect(() => decodeFiltersSegment('x'.repeat(5000))).toThrow();
  });
});

describe('date ranges and opponent strength', () => {
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);

  it('resolves presets relative to now', () => {
    expect(resolveDateRange({ period: '24h' }, now)).toEqual({ from: now - 86_400_000, to: now });
    expect(resolveDateRange({ period: '3m' }, now)).toEqual({ from: Date.UTC(2026, 7, 23, 12, 0, 0), to: now });
    expect(resolveDateRange({ period: '12m' }, now)).toEqual({ from: Date.UTC(2025, 10, 23, 12, 0, 0), to: now });
  });

  it('resolves custom dates as inclusive UTC days', () => {
    expect(resolveDateRange({ from: '2026-01-01', to: '2026-01-31' }, now)).toEqual({
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 1, 1) - 1,
    });
    expect(resolveDateRange({}, now)).toEqual({ from: null, to: null });
  });

  it('maps opponent strength buckets to rating differences', () => {
    expect(oppStrengthRange('-200')).toEqual({ minDiff: null, maxDiff: -200 });
    expect(oppStrengthRange('eq')).toEqual({ minDiff: -100, maxDiff: 100 });
    expect(oppStrengthRange('200')).toEqual({ minDiff: 200, maxDiff: null });
  });
});

describe('player specs', () => {
  it('parses and formats every kind', () => {
    const cases = ['magnus-carlsen', 'lichess:drnykterstein', 'chesscom:hikaru', 'db:12', 'ref:1503014'];
    for (const c of cases) expect(formatPlayerSpec(parsePlayerSpec(c)!)).toBe(c);
    expect(parsePlayerSpec('lichess:DrNykterstein')).toEqual({ kind: 'lichess', username: 'drnykterstein' });
  });

  it('rejects malformed specs', () => {
    for (const c of ['', 'a', 'Upper', '-ab', 'db:0', 'db:x', 'ref:abc', 'fide:1', 'lichess:', 'lichess:a b'])
      expect(parsePlayerSpec(c)).toBeNull();
  });
});
