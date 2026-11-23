import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/http/upstream.ts';
import { GameImporter, readJsonBody } from '../src/sync/common.ts';
import { countryFromLichessFlag, initialCutoff, readNdjson } from '../src/sync/index.ts';
import { createSource, makeJobContext, makeTestApp, testGame, type TestApp } from './helpers.ts';

/** A response whose body is the given chunks, then (optionally) a stall or an error. */
function chunked(chunks: string[], end: 'close' | 'error' | 'stall' = 'close'): { res: Response; cancelled: () => boolean } {
  const enc = new TextEncoder();
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): Promise<void> | void {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!));
        return undefined;
      }
      if (end === 'stall') return new Promise<void>(() => {}); // never sends anything again
      if (end === 'close') controller.close();
      else controller.error(new TypeError('terminated'));
      return undefined;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream), cancelled: () => cancelled };
}

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
};

describe('readNdjson', () => {
  const signal = new AbortController().signal;

  it('splits lines across chunks, skips keep-alive lines and reads a last line without newline', async () => {
    const { res } = chunked(['{"a":', '1}\n\n', '   \n{"a":2}\n{"a"', ':3}']);
    expect(await collect(readNdjson<{ a: number }>(res, 'lichess.org', signal))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('turns a dropped connection, a malformed line and a stall into retryable upstream errors', async () => {
    const dropped = await collect(readNdjson(chunked(['{"a":1}\n'], 'error').res, 'lichess.org', signal)).catch(e => e);
    expect(dropped).toBeInstanceOf(UpstreamError);
    expect(dropped).toMatchObject({ reason: 'network', host: 'lichess.org' });

    const malformed = await collect(readNdjson(chunked(['{"a":1}\n{"a":\n']).res, 'lichess.org', signal)).catch(e => e);
    expect(malformed).toMatchObject({ reason: 'network' });
    expect(malformed.message).toMatch(/malformed/);

    const stalled = await collect(readNdjson(chunked(['{"a":1}\n'], 'stall').res, 'lichess.org', signal, 30)).catch(e => e);
    expect(stalled).toMatchObject({ reason: 'timeout' });
  });

  it('closes the connection when the consumer stops early', async () => {
    const body = chunked(['{"a":1}\n{"a":2}\n', '{"a":3}\n'], 'stall');
    for await (const v of readNdjson<{ a: number }>(body.res, 'lichess.org', signal)) if (v.a === 2) break;
    expect(body.cancelled()).toBe(true);
  });

  it('rethrows the abort reason (not a retryable error) when the job is cancelled mid-stream', async () => {
    const c = new AbortController();
    const reason = new Error('cancelled by admin');
    // Like fetch: aborting the request signal errors the body stream.
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"a":1}\n'));
          return;
        }
        return new Promise<void>((_, reject) => c.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      },
    });
    const gen = readNdjson(new Response(stream), 'lichess.org', c.signal);
    expect((await gen.next()).value).toEqual({ a: 1 });
    const next = gen.next();
    c.abort(reason);
    await expect(next).rejects.toBe(reason);
  });
});

describe('readJsonBody', () => {
  const signal = new AbortController().signal;

  it('parses JSON and turns error pages and broken bodies into retryable errors', async () => {
    expect(await readJsonBody(new Response('{"ok":true}'), 'api.chess.com', signal)).toEqual({ ok: true });
    const page = await readJsonBody(new Response('<html>oops</html>'), 'api.chess.com', signal).catch(e => e);
    expect(page).toMatchObject({ reason: 'status', status: 503 });
    const broken = await readJsonBody(chunked(['{"games":['], 'error').res, 'api.chess.com', signal).catch(e => e);
    expect(broken).toMatchObject({ reason: 'network' });
    const slow = await readJsonBody(chunked(['{"games":['], 'stall').res, 'api.chess.com', signal, 30).catch(e => e);
    expect(slow).toMatchObject({ reason: 'timeout' });
  });
});

describe('sync helpers', () => {
  it('computes the first import window in calendar months', () => {
    expect(initialCutoff(Date.UTC(2026, 10, 23, 12), 0)).toBeNull();
    expect(initialCutoff(Date.UTC(2026, 10, 23, 12), 1)).toBe(Date.UTC(2026, 9, 23, 12));
    expect(initialCutoff(Date.UTC(2026, 0, 15), 3)).toBe(Date.UTC(2025, 9, 15));
    // 31 March minus one month is the last day of February.
    expect(initialCutoff(Date.UTC(2028, 2, 31, 8), 1)).toBe(Date.UTC(2028, 1, 29, 8));
  });

  it('reads countries from Lichess flags', () => {
    expect(countryFromLichessFlag('NO')).toBe('NO');
    expect(countryFromLichessFlag('GB-SCT')).toBe('GB');
    expect(countryFromLichessFlag('ES-CT')).toBe('ES');
    expect(countryFromLichessFlag('_earth')).toBeNull();
    expect(countryFromLichessFlag('_pirate')).toBeNull();
    expect(countryFromLichessFlag(undefined)).toBeNull();
  });
});

describe('GameImporter', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => t.close());

  it('stores batches with the cursor in one transaction and counts duplicates and illegal games', async () => {
    const src = createSource(t.db, { kind: 'lichess', key: 'alice' });
    const { ctx, updates } = makeJobContext(t, 'sync', { sourceId: src });
    const importer = new GameImporter(ctx, src, 2);
    const a = testGame();
    expect(importer.add(a)).toBe(false);
    expect(importer.add(testGame({ moves: ['e4', 'e4'] }))).toBe(true);
    await importer.flush(() => t.db.run("UPDATE sources SET sync_state_json = '{\"n\":1}' WHERE id = ?", [src]));
    importer.add({ ...a });
    importer.skip();
    await importer.flush();
    importer.report(4, null, 'done');
    expect(importer.counts).toEqual({ imported: 1, duplicates: 1, skipped: 2 });
    expect(updates.at(-1)).toEqual({ done: 4, total: null, message: 'done', counts: { imported: 1, duplicates: 1, skipped: 2 } });
    expect(t.db.value('SELECT sync_state_json FROM sources WHERE id = ?', [src])).toBe('{"n":1}');
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [src])).toBe(1);

    // A failing batch rolls back its games and its cursor together.
    importer.add(testGame());
    await expect(
      importer.flush(() => {
        t.db.run("UPDATE sources SET sync_state_json = '{\"n\":2}' WHERE id = ?", [src]);
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(t.db.value('SELECT sync_state_json FROM sources WHERE id = ?', [src])).toBe('{"n":1}');
    expect(t.db.value('SELECT COUNT(*) FROM games')).toBe(1);
  });
});
