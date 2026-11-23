import { gzipSync, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parsePgnGames } from '../src/chess/index.ts';
import { addMonths, broadcastMonthProblem, estimatedBroadcastMonths, monthOf, monthRange, parseMonthList } from '../src/reference/months.ts';
import { broadcastChapterKey, toReferenceGame } from '../src/reference/normalize.ts';
import { foldName } from '../src/reference/players.ts';
import { decompressAuto, detectCompression, SizeLimitError, UnsupportedFormatError } from '../src/reference/stream.ts';
import { otbTimeClass, otbTimeControl, parseOtbTimeControl, timeClassFromWords } from '../src/reference/timeControl.ts';
import { importUrlProblem, isNonPublicHost, lichessBroadcastUrl } from '../src/reference/urls.ts';

async function* chunksOf(buf: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

describe('OTB time controls', () => {
  it.each([
    ['90+30', 5400, 30, 'classical'],
    ['60+30', 3600, 30, 'classical'],
    ['3+2', 180, 2, 'blitz'],
    ['10+5', 600, 5, 'rapid'],
    ['25+10', 1500, 10, 'rapid'],
    ['45+10', 2700, 10, 'rapid'],
    ['5400+30', 5400, 30, 'classical'],
    ['1800+3', 1800, 3, 'rapid'],
    ['180+2', 180, 2, 'blitz'],
    ['15|10', 900, 10, 'rapid'],
    ['G: 15 minutes + 5 seconds increment from move 1', 900, 5, 'rapid'],
    ['G: 3 minutes + 2 seconds increment from move 1', 180, 2, 'blitz'],
    ['90 min + 30 sec 40/15', 5400, 30, 'classical'],
    ['100 minutes/40 moves + 40 minutes/rest with 30 seconds increment from move 1.', 6000, 30, 'classical'],
    ['90min / 40 + 30 min Rest + 30 sec per move', 5400, 30, 'classical'],
    ['G/90; +30', 5400, 30, 'classical'],
    ["90' + 30 move", 5400, 30, 'classical'],
    ['Standard: 60 minutes with 30 seconds increment from move 1', 3600, 30, 'classical'],
    ['2 hours + 30 seconds', 7200, 30, 'classical'],
  ])('%s', (tc, initial, increment, timeClass) => {
    expect(parseOtbTimeControl(tc)).toEqual({ initial, increment });
    expect(otbTimeControl(tc).timeClass).toBe(timeClass);
  });

  it('reads PGN multi-period controls as seconds and keeps the tag', () => {
    expect(otbTimeControl('40/5400+30:1800+30')).toEqual({ timeClass: 'classical', timeControl: '40/5400+30:1800+30' });
    expect(otbTimeControl('90+30').timeControl).toBe('5400+30');
  });

  it('falls back to the tour FIDE time control and event names, else unknown', () => {
    expect(otbTimeControl('Fagernes International Autumn 2026')).toEqual({ timeClass: 'unknown', timeControl: null });
    expect(otbTimeControl(null, { fideTC: 'rapid' }).timeClass).toBe('rapid');
    expect(otbTimeControl(null, { fideTC: 'standard' }).timeClass).toBe('classical');
    expect(otbTimeControl(null, { names: ['Open | Blitz'] }).timeClass).toBe('blitz');
    expect(otbTimeControl(null, { names: ['Rapid & Blitz Finals'] }).timeClass).toBe('unknown');
    expect(timeClassFromWords('Rapid & Blitz')).toBeNull();
    expect(otbTimeClass({ initial: 60, increment: 0 })).toBe('bullet');
    expect(otbTimeClass({ initial: 600, increment: 0 })).toBe('blitz');
    expect(otbTimeClass({ initial: 3600, increment: 0 })).toBe('classical');
  });
});

describe('broadcast months', () => {
  const now = Date.UTC(2026, 10, 23, 12); // 2026-11-23

  it('validates format, range and completeness', () => {
    expect(broadcastMonthProblem('2026-10', now)).toBeNull();
    expect(broadcastMonthProblem('2020-01', now)).toBeNull();
    expect(broadcastMonthProblem('2019-12', now)).toMatch(/before the first/);
    expect(broadcastMonthProblem('2026-11', now)).toMatch(/not over yet/);
    expect(broadcastMonthProblem('2026-12', now)).toMatch(/future/);
    expect(broadcastMonthProblem('2026-13', now)).toMatch(/not a month/);
    expect(broadcastMonthProblem('2026-1', now)).toMatch(/not a month/);
    expect(broadcastMonthProblem("2026-01'; --", now)).toMatch(/not a month/);
  });

  it('does month arithmetic and parses list.txt', () => {
    expect(monthOf(now)).toBe('2026-11');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(
      parseMonthList(
        'https://database.lichess.org/broadcast/lichess_db_broadcast_2026-10.pgn.zst\n' +
          'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-01.pgn.zst',
      ),
    ).toEqual(['2020-01', '2026-10']);
    const est = estimatedBroadcastMonths(now);
    expect(est[0]).toBe('2020-01');
    expect(est.at(-1)).toBe('2026-10');
    expect(estimatedBroadcastMonths(Date.UTC(2026, 10, 5)).at(-1)).toBe('2026-09');
  });
});

describe('import URLs', () => {
  it('accepts public https URLs only', () => {
    expect(importUrlProblem('https://example.com/games.pgn')).toBeNull();
    expect(importUrlProblem('http://example.com/games.pgn')).toMatch(/https/);
    expect(importUrlProblem('ftp://example.com/x')).toMatch(/https/);
    expect(importUrlProblem('not a url')).toMatch(/valid/);
    expect(importUrlProblem('https://user:pw@example.com/x')).toMatch(/credentials/);
    expect(importUrlProblem(`https://example.com/${'a'.repeat(3000)}`)).toMatch(/longer/);
    for (const host of ['localhost', 'foo.localhost', '127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '[::1]', '[fd00::1]', '[::ffff:127.0.0.1]', 'nas.local', 'intranet', '0.0.0.0']) {
      expect(importUrlProblem(`https://${host}/x.pgn`), host).toMatch(/not a public host/);
    }
    expect(isNonPublicHost('8.8.8.8')).toBe(false);
    expect(isNonPublicHost('[2001:db8::1]')).toBe(false);
  });

  it('recognises Lichess broadcast rounds and tours', () => {
    expect(lichessBroadcastUrl('https://lichess.org/broadcast/some-open/round-4/6W8sy3kg')).toEqual({ kind: 'round', roundId: '6W8sy3kg' });
    expect(lichessBroadcastUrl('https://lichess.org/broadcast/some-open/round-4/6W8sy3kg/gET308sb')).toEqual({ kind: 'round', roundId: '6W8sy3kg' });
    expect(lichessBroadcastUrl('https://lichess.org/api/broadcast/round/6W8sy3kg.pgn')).toEqual({ kind: 'round', roundId: '6W8sy3kg' });
    expect(lichessBroadcastUrl('https://lichess.org/broadcast/some-open/qfkdt8mn')).toEqual({
      kind: 'tour',
      tourId: 'qfkdt8mn',
      pgnUrl: 'https://lichess.org/api/broadcast/qfkdt8mn.pgn',
    });
    expect(lichessBroadcastUrl('https://lichess.org/study/abcdefgh')).toBeNull();
    expect(lichessBroadcastUrl('https://evil.example/broadcast/a/b/6W8sy3kg')).toBeNull();
  });
});

describe('names and chapter keys', () => {
  it('folds names for search', () => {
    expect(foldName('Carlsen, Magnus')).toBe('carlsen magnus');
    expect(foldName('  Ødegård,  Jöns-Åke ')).toBe('odegard jons ake');
    expect(foldName('Łukasz Straße')).toBe('lukasz strasse');
    expect(foldName('Иванов, Иван')).toBe('иванов иван');
  });

  it('extracts round/chapter ids from broadcast game URLs', () => {
    expect(broadcastChapterKey('https://lichess.org/broadcast/a-b/round-1/6W8sy3kg/gET308sb')).toBe('6W8sy3kg/gET308sb');
    expect(broadcastChapterKey('https://lichess.org/broadcast/a-b/round-1/6W8sy3kg')).toBeNull();
    expect(broadcastChapterKey('tcec-chess.com')).toBeNull();
    expect(broadcastChapterKey(null)).toBeNull();
  });
});

describe('toReferenceGame', () => {
  const one = async (pgn: string) => {
    for await (const g of parsePgnGames(pgn)) return g;
    throw new Error('no game');
  };

  it('maps broadcast tags: event, url, time class, termination, ratings in names', async () => {
    const g = toReferenceGame(
      await one(`[Event "Round 1: A - B"]
[White "2162 Some Amateur"]
[Black "Other, Player"]
[Result "1/2-1/2"]
[BlackElo "2010"]
[TimeControl "60+30"]
[Termination "3-Fold repetition"]
[UTCDate "2026.01.02"]
[UTCTime "10:00:00"]
[BroadcastName "Club Open | A"]
[GameURL "https://lichess.org/broadcast/club-open/round-1/Abcdefgh/Chapter1"]
[BlackFed "nor"]

1. e4 e5 2. Nf3 Nc6 1/2-1/2`),
      { databaseId: 7 },
    );
    if ('skip' in g) throw new Error(g.skip);
    expect(g.chapterKey).toBe('Abcdefgh/Chapter1');
    expect(g.game).toMatchObject({
      origin: 'reference',
      databaseId: 7,
      event: 'Club Open | A',
      url: 'https://lichess.org/broadcast/club-open/round-1/Abcdefgh/Chapter1',
      timeClass: 'classical',
      timeControl: '3600+30',
      termination: 'repetition',
      endedAt: Date.UTC(2026, 0, 2, 10),
    });
    expect(g.game.white).toMatchObject({ name: 'Some Amateur', rating: 2162 });
    expect(g.game.black).toMatchObject({ name: 'Other, Player', rating: 2010 });
    expect(g.federations).toEqual({ white: null, black: 'NOR' });
  });

  it('skips engines and unplayed boards; uses round hints', async () => {
    const engine = await one('[White "E1"]\n[Black "E2"]\n[WhiteTitle "BOT"]\n[Result "1-0"]\n\n1. e4 1-0');
    expect(toReferenceGame(engine, { databaseId: 1 })).toEqual({ skip: 'engine' });
    const unplayed = await one('[White "A"]\n[Black "B"]\n[Termination "Unplayed"]\n[Result "1-0"]\n\n1. e4 1-0');
    expect(toReferenceGame(unplayed, { databaseId: 1 })).toEqual({ skip: 'unplayed' });
    const bye = await one('[White "BYE"]\n[Black "B"]\n[Result "0-1"]\n\n1. e4 e5 0-1');
    expect(toReferenceGame(bye, { databaseId: 1 })).toEqual({ skip: 'unplayed' });
    const plain = await one('[White "A"]\n[Black "B"]\n[WhiteFideId "123"]\n[Date "2026.01.01"]\n[Result "0-1"]\n\n1. e4 e5 0-1');
    const startsAt = Date.UTC(2026, 0, 3, 14);
    const r = toReferenceGame(plain, {
      databaseId: 1,
      round: { tourName: 'Tour', startsAt, fideTC: 'blitz', federations: new Map([['123', 'ESP']]) },
    });
    if ('skip' in r) throw new Error(r.skip);
    expect(r.game).toMatchObject({ event: 'Tour', timeClass: 'blitz', endedAt: startsAt });
    expect(r.federations.white).toBe('ESP');
  });

  it('leaves non-broadcast PGNs to the PGN standard', async () => {
    const g = toReferenceGame(await one('[White "A"]\n[Black "B"]\n[TimeControl "180+2"]\n[Event "Club"]\n[Result "1-0"]\n\n1. e4 e5 1-0'), {
      databaseId: 1,
    });
    if ('skip' in g) throw new Error(g.skip);
    expect(g).toMatchObject({ chapterKey: null, game: { event: 'Club', timeClass: 'blitz', timeControl: '180+2' } });
  });
});

describe('streams', () => {
  const text = '[Event "x"]\n\n1. e4 *\n'.repeat(50);

  it('detects and decompresses zstd and gzip, passing plain text through', async () => {
    expect(detectCompression(zstdCompressSync(Buffer.from(text)))).toBe('zstd');
    expect(detectCompression(gzipSync(Buffer.from(text)))).toBe('gzip');
    expect(detectCompression(Buffer.from(text))).toBe('none');
    expect(await collect(decompressAuto(chunksOf(zstdCompressSync(Buffer.from(text)))))).toBe(text);
    expect(await collect(decompressAuto(chunksOf(gzipSync(Buffer.from(text)), 3)))).toBe(text);
    expect(await collect(decompressAuto(chunksOf(Buffer.from(text), 2)))).toBe(text);
    expect(await collect(decompressAuto(chunksOf(Buffer.alloc(0))))).toBe('');
  });

  it('recognises zstd files that start with a skippable frame (database.lichess.org)', async () => {
    const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
    const file = Buffer.concat([skippable, zstdCompressSync(Buffer.from(text))]);
    expect(detectCompression(file)).toBe('zstd');
    expect(detectCompression(Buffer.from([0x5e, 0x2a, 0x4d, 0x18]))).toBe('zstd');
    expect(await collect(decompressAuto(chunksOf(file, 5)))).toBe(text);
  });

  it('closes the source when the consumer stops early or the format is refused', async () => {
    for (const [input, compressed] of [
      [Buffer.from(text), false],
      [zstdCompressSync(Buffer.from(text.repeat(20))), true],
    ] as const) {
      let closed = false;
      const source = async function* () {
        try {
          yield* chunksOf(input, 16);
        } finally {
          closed = true;
        }
      };
      for await (const _ of decompressAuto(source())) break;
      await new Promise(r => setTimeout(r, 10));
      expect(closed, compressed ? 'zstd' : 'plain').toBe(true);
    }
    let closed = false;
    const zip = async function* () {
      try {
        yield Buffer.from('PK\x03\x04');
        yield Buffer.from('more');
      } finally {
        closed = true;
      }
    };
    await expect(collect(decompressAuto(zip()))).rejects.toBeInstanceOf(UnsupportedFormatError);
    await new Promise(r => setTimeout(r, 10));
    expect(closed).toBe(true);
  });

  it('refuses zip and bzip2 and caps the output', async () => {
    await expect(collect(decompressAuto(chunksOf(Buffer.from('PK\x03\x04rest'))))).rejects.toBeInstanceOf(UnsupportedFormatError);
    await expect(collect(decompressAuto(chunksOf(Buffer.from('BZh91AY'))))).rejects.toBeInstanceOf(UnsupportedFormatError);
    await expect(collect(decompressAuto(chunksOf(zstdCompressSync(Buffer.from(text))), { maxOutput: 100 }))).rejects.toBeInstanceOf(
      SizeLimitError,
    );
    await expect(collect(decompressAuto(chunksOf(zstdCompressSync(Buffer.from(text)).subarray(0, 20))))).rejects.toThrow();
  });
});
