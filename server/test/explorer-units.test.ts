/** Unit tests of the explorer building blocks: request budget, http_cache policy, LRU, PGN, positions. */
import { describe, expect, it } from 'vitest';
import { getOpeningBook } from '../src/chess/openings.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { BudgetError, RequestBudget } from '../src/explorer/budget.ts';
import { CACHE_POLICY, cacheKey, ExplorerCache, freshness } from '../src/explorer/cache.ts';
import { Lru } from '../src/explorer/lru.ts';
import { parseRange } from '../src/explorer/nnue.ts';
import { checkVariantLine, lichessUpstreamQuery, lichessQuerySchema, mastersQuerySchema, mastersUpstreamQuery } from '../src/explorer/params.ts';
import { gamePgn, movetext } from '../src/explorer/pgn.ts';
import { resolvePosition } from '../src/explorer/position.ts';
import { fideDp } from '../src/explorer/responses.ts';

/** A manual clock with timers. */
function manualClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    },
    pending: () => timers.size,
  };
}

describe('RequestBudget', () => {
  const make = (over: Partial<ConstructorParameters<typeof RequestBudget>[0]> = {}) => {
    const clock = manualClock();
    const budget = new RequestBudget({
      perWindow: 2,
      windowMs: 60_000,
      maxQueue: 3,
      maxWaitMs: 90_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ...over,
    });
    return { clock, budget };
  };
  const track = (p: Promise<void>) => {
    const s = { state: 'pending' as 'pending' | 'ok' | 'error', error: null as BudgetError | null };
    p.then(
      () => (s.state = 'ok'),
      (e: BudgetError) => {
        s.state = 'error';
        s.error = e;
      },
    );
    return s;
  };

  it('grants perWindow slots at once, then one per expiring slot, in FIFO order', async () => {
    const { clock, budget } = make();
    const a = track(budget.acquire());
    const b = track(budget.acquire());
    const c = track(budget.acquire());
    const d = track(budget.acquire());
    await clock.advance(0);
    expect([a.state, b.state, c.state, d.state]).toEqual(['ok', 'ok', 'pending', 'pending']);
    expect(budget.queued).toBe(2);
    expect(budget.nextSlotAt()).toBe(clock.now() + 60_000);
    await clock.advance(59_000);
    expect(c.state).toBe('pending');
    await clock.advance(2_000);
    expect([c.state, d.state]).toEqual(['ok', 'ok']);
    expect(budget.queued).toBe(0);
    expect(budget.used).toBe(2);
  });

  it('is a sliding window', async () => {
    const { clock, budget } = make();
    await budget.acquire();
    await clock.advance(30_000);
    await budget.acquire();
    const c = track(budget.acquire());
    await clock.advance(30_001);
    expect(c.state).toBe('ok'); // the first grant expired
    const d = track(budget.acquire());
    await clock.advance(29_000);
    expect(d.state).toBe('pending');
    await clock.advance(1_100);
    expect(d.state).toBe('ok');
  });

  it('rejects when the queue is full and when the wait is too long', async () => {
    const { clock, budget } = make({ maxQueue: 1, maxWaitMs: 10_000 });
    await budget.acquire();
    await budget.acquire();
    const queued = track(budget.acquire());
    const full = track(budget.acquire());
    await clock.advance(0);
    expect(full.state).toBe('error');
    expect(full.error!.reason).toBe('queue_full');
    expect(full.error!.retryAt).toBe(clock.now() + 60_000);
    await clock.advance(10_001);
    expect(queued.state).toBe('error');
    expect(queued.error!.reason).toBe('queue_timeout');
    expect(budget.queued).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it('removes aborted waiters without losing the others’ places', async () => {
    const { clock, budget } = make({ perWindow: 1 });
    await budget.acquire();
    const ac = new AbortController();
    const a = track(budget.acquire(ac.signal));
    const b = track(budget.acquire());
    ac.abort();
    await clock.advance(0);
    expect(a.state).toBe('error');
    expect(a.error!.reason).toBe('aborted');
    expect(budget.queued).toBe(1);
    await clock.advance(60_001);
    expect(b.state).toBe('ok');
    const pre = new AbortController();
    pre.abort();
    await expect(budget.acquire(pre.signal)).rejects.toMatchObject({ reason: 'aborted' });
  });
});

describe('explorer http_cache', () => {
  it('has per-kind freshness, with shorter lifetimes for misses and a stale window', () => {
    const t0 = 1_000_000_000;
    const at = (age: number, status = 200) => freshness('masters', { status, fetchedAt: t0 - age }, t0);
    expect(at(0)).toBe('fresh');
    expect(at(CACHE_POLICY.masters.ttlMs - 1)).toBe('fresh');
    expect(at(CACHE_POLICY.masters.ttlMs)).toBe('stale');
    expect(at(CACHE_POLICY.masters.ttlMs + CACHE_POLICY.masters.staleMs)).toBe('expired');
    expect(freshness('cloud-eval', { status: 404, fetchedAt: t0 - 11 * 60_000 }, t0)).toBe('stale');
    expect(freshness('cloud-eval', { status: 200, fetchedAt: t0 - 11 * 60_000 }, t0)).toBe('fresh');
  });

  it('stores, revalidates and prunes only explorer entries', () => {
    const db = openDb(':memory:');
    migrate(db);
    let now = 5_000_000_000;
    const cache = new ExplorerCache(db, () => now);
    const key = cacheKey('tablebase', 'standard:x');
    cache.put(key, { status: 200, body: '{"a":1}', contentType: 'application/json', etag: '"e"' });
    expect(cache.get(key)).toMatchObject({ status: 200, body: '{"a":1}', etag: '"e"', fetchedAt: now });
    cache.put(cacheKey('cloud-eval', 'fen=y'), { status: 404, body: '', contentType: 'application/json', etag: null });
    db.run("INSERT INTO http_cache (key, body, content_type, fetched_at) VALUES ('broadcast:other', 'x', 'text/plain', 0)");
    now += 2 * 24 * 3_600_000;
    cache.touch(key);
    expect(cache.get(key)!.fetchedAt).toBe(now);
    expect(cache.prune()).toBe(1); // the old cloud-eval miss; the touched tablebase entry and other modules' rows stay
    expect(cache.get(cacheKey('cloud-eval', 'fen=y'))).toBeNull();
    expect(db.value("SELECT count(*) FROM http_cache WHERE key = 'broadcast:other'")).toBe(1);
    now += 365 * 24 * 3_600_000;
    expect(cache.prune()).toBe(1);
    db.close();
  });
});

describe('Lru', () => {
  it('evicts the least recently used entry and expires entries', () => {
    let now = 0;
    const lru = new Lru<number>({ max: 2, ttlMs: 100, now: () => now });
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    now = 100;
    expect(lru.get('a')).toBeUndefined();
    expect(lru.size).toBe(1);
  });
});

describe('positions and upstream queries', () => {
  const book = getOpeningBook();

  it('resolves fen + play to the same key as a direct FEN', () => {
    const a = resolvePosition(undefined, 'e2e4,e7e5,g1f3', book);
    const b = resolvePosition('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', undefined, book);
    expect(a.key).toBe(b.key);
    expect(a.line).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(a.opening).toEqual({ eco: 'C40', name: "King's Knight Opening" });
  });

  it('accepts both castling notations and normalises to e1g1', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(resolvePosition(fen, 'e1h1', book).line).toEqual(['e1g1']);
    expect(resolvePosition(fen, 'e1g1', book).key).toBe(resolvePosition(fen, 'e1h1', book).key);
  });

  it('builds canonical masters and lichess queries', () => {
    const m = mastersUpstreamQuery(mastersQuerySchema.parse({ play: 'e2e4', until: '2020', since: '1990', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-_0_1' }));
    expect(m.toString()).toBe('fen=rnbqkbnr%2Fpppppppp%2F8%2F8%2F8%2F8%2FPPPPPPPP%2FRNBQKBNR+w+KQkq+-+0+1&play=e2e4&since=1990&until=2020');
    const l = lichessUpstreamQuery(lichessQuerySchema.parse({ variant: 'fromPosition', speeds: 'classical,bullet', ratings: '2500,1600', history: 'true' }));
    expect(l.toString()).toBe('history=true&ratings=1600%2C2500&speeds=bullet%2Cclassical&variant=standard');
  });

  it('checks variant lines with chessops rules', () => {
    const zh = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1';
    expect(checkVariantLine('crazyhouse', zh, 'e2e4,d7d5,e4d5,d8d5').play).toHaveLength(4);
    expect(() => checkVariantLine('crazyhouse', zh, 'e2e4,d7d5,e4d5,d8d5,P@e7')).toThrow();
    expect(() => checkVariantLine('atomic', undefined, 'zz')).toThrow();
  });
});

describe('PGN and performance helpers', () => {
  it('writes movetext with numbers, wrapping and the result', () => {
    expect(movetext(['e4', 'e5', 'Nf3'], '1-0')).toBe('1. e4 e5 2. Nf3 1-0');
    const long = movetext(Array.from({ length: 60 }, () => 'Nf3'), '*');
    expect(long.split('\n').every(l => l.length <= 80)).toBe(true);
  });

  it('writes tags from the stored columns and the original headers', () => {
    const pgn = gamePgn({
      id: 1,
      url: null,
      database_id: 1,
      white: 'A "Quoted" Player',
      black: 'B',
      white_rating: 2500,
      black_rating: null,
      white_title: 'GM',
      black_title: null,
      white_fide_id: '123',
      black_fide_id: null,
      result: '0-1',
      time_control: '5400+30',
      event: null,
      round: null,
      started_at: null,
      ended_at: null,
      moves_san: 'f3 e5 g4 Qh4#',
      eco: 'A00',
      opening_name: 'Barnes Opening',
      headers_json: JSON.stringify({ Event: 'Club Ch', Site: 'Somewhere', Date: '2001.??.??', Round: '3' }),
    });
    expect(pgn).toContain('[Event "Club Ch"]');
    expect(pgn).toContain('[Site "Somewhere"]');
    expect(pgn).toContain('[Date "2001.??.??"]');
    expect(pgn).toContain('[Round "3"]');
    expect(pgn).toContain('[White "A \\"Quoted\\" Player"]');
    expect(pgn).not.toContain('BlackElo');
    expect(pgn).toContain('[WhiteFideId "123"]');
    expect(pgn.trim().endsWith('1. f3 e5 2. g4 Qh4# 0-1')).toBe(true);
  });

  it('uses the FIDE dp table', () => {
    expect(fideDp(0.5)).toBe(0);
    expect(fideDp(1)).toBe(800);
    expect(fideDp(0)).toBe(-800);
    expect(fideDp(0.75)).toBe(193);
    expect(fideDp(0.25)).toBe(-193);
    expect(fideDp(0.9)).toBe(366);
  });

  it('parses Range headers', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-1', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});
