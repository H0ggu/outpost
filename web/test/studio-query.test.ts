/** Studio query parameters (src/studio/query.ts, PLAN §8.4). */
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { describe, expect, it } from 'vitest';
import { paths, studioPlayerExplorer } from '../src/app/paths.ts';
import { cleanFen, parseStudioQuery } from '../src/studio/query.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('parseStudioQuery', () => {
  it('reads every parameter the SPA links with', () => {
    const seg = encodeFiltersSegment({ color: 'white', tc: ['blitz'] });
    const q = parseStudioQuery(studioPlayerExplorer('hikaru', 'black', { color: 'white', tc: ['blitz'] }, true).split('?')[1]!);
    expect(q).toEqual({ embed: true, explorer: { db: 'player', player: 'hikaru' }, color: 'black', filters: seg });
  });

  it('accepts game ids as Outpost (123) or explorer (op123) ids', () => {
    expect(parseStudioQuery('?game=123').game).toBe(123);
    expect(parseStudioQuery('?game=op123').game).toBe(123);
    expect(parseStudioQuery(paths.studio({ game: 7 }).split('?')[1]!).game).toBe(7);
    for (const bad of ['0', 'op0', '-1', '12a', 'abcd1234', '9999999999999999999']) expect(parseStudioQuery(`?game=${bad}`).game).toBeUndefined();
  });

  it('reads files, PGN and FEN', () => {
    const pgn = '1. e4 e5 2. Nf3 *';
    const q = parseStudioQuery(new URLSearchParams({ file: '42', pgn, fen: START }));
    expect(q).toMatchObject({ file: 42, pgn, fen: START, embed: false });
    expect(parseStudioQuery('?pgn=%20%20').pgn).toBeUndefined();
    expect(parseStudioQuery(`?pgn=${'x'.repeat(200_001)}`).pgn).toBeUndefined();
    expect(parseStudioQuery('?file=x').file).toBeUndefined();
  });

  it('keeps an unreadable FEN aside so the Studio can say so', () => {
    expect(parseStudioQuery('?fen=notafen')).toEqual({ embed: false, badFen: 'notafen' });
    expect(parseStudioQuery(`?fen=${encodeURIComponent(START)}`)).toEqual({ embed: false, fen: START });
    expect(parseStudioQuery('?fen=%20').badFen).toBeUndefined();
  });

  it('reads the explorer databases and ignores unknown ones', () => {
    expect(parseStudioQuery('?explorer=masters').explorer).toEqual({ db: 'masters' });
    expect(parseStudioQuery('?explorer=lichess').explorer).toEqual({ db: 'lichess' });
    expect(parseStudioQuery('?explorer=reference').explorer).toEqual({ db: 'reference' });
    expect(parseStudioQuery('?explorer=player:lichess:DrNykterstein').explorer).toEqual({ db: 'player', player: 'lichess:DrNykterstein' });
    expect(parseStudioQuery('?explorer=player:db:3').explorer).toEqual({ db: 'player', player: 'db:3' });
    expect(parseStudioQuery('?explorer=player:').explorer).toBeUndefined();
    expect(parseStudioQuery('?explorer=player:Not A Slug').explorer).toBeUndefined();
    expect(parseStudioQuery('?explorer=chessbase').explorer).toBeUndefined();
  });

  it('keeps only decodable filter segments, never the empty one', () => {
    expect(parseStudioQuery('?filters=_').filters).toBeUndefined();
    expect(parseStudioQuery('?filters=%%%').filters).toBeUndefined();
    expect(parseStudioQuery(`?filters=${encodeFiltersSegment({ rated: 'rated' })}`).filters).toBe(encodeFiltersSegment({ rated: 'rated' }));
  });

  it('ignores invalid colours and embeds', () => {
    expect(parseStudioQuery('?color=red&embed=yes')).toEqual({ embed: false });
  });
});

describe('cleanFen', () => {
  it('accepts lila’s underscore style and normalises spaces', () => {
    expect(cleanFen(START.replace(/ /g, '_'))).toBe(START);
    expect(cleanFen(`  ${START.replace(/ /g, '   ')} `)).toBe(START);
    expect(cleanFen('8/8/8/4k3/8/8/4K3/8 w - -')).toBe('8/8/8/4k3/8/8/4K3/8 w - -');
  });

  it('rejects junk', () => {
    expect(cleanFen('')).toBeUndefined();
    expect(cleanFen(null)).toBeUndefined();
    expect(cleanFen('hello')).toBeUndefined();
    expect(cleanFen(`${START} ${'x'.repeat(200)}`)).toBeUndefined();
  });
});
