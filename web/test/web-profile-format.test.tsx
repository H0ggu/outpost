import { describe, expect, it } from 'vitest';
import { decodeFiltersSegment } from '@outpost/shared/filters';
import { describeFilters } from '../src/app/pages/profile/components/FiltersBar.tsx';
import { bestTitle } from '../src/app/pages/profile/components/ProfileHead.tsx';
import { columnPath, scoreBin, seqBin } from '../src/app/pages/profile/components/charts/common.tsx';
import { isoToday } from '../src/app/pages/profile/components/charts/Heatmaps.tsx';
import { seriesKey, toChartSeries } from '../src/app/pages/profile/components/charts/ratingSeries.ts';
import {
  fmtCompact,
  fmtCountdown,
  fmtLine,
  fmtPct,
  fmtRelative,
  fmtTimeControl,
  lineToSanMoves,
  numberedSan,
  parseMovesInput,
  scoreOfWdl,
} from '../src/app/pages/profile/format.ts';
import { explorerTabAt, studioExplorerLink, studioGameLink } from '../src/app/pages/profile/links.ts';

describe('number and time formatting', () => {
  it('formats counts, shares and scores', () => {
    expect(fmtCompact(987)).toBe('987');
    expect(fmtCompact(12_345)).toBe('12.3K');
    expect(fmtCompact(250_000)).toBe('250K');
    expect(fmtCompact(1_500_000)).toBe('1.5M');
    expect(fmtPct(0.537)).toBe('54%');
    expect(fmtPct(null)).toBe('–');
    expect(scoreOfWdl({ w: 3, d: 2, l: 5 })).toBe(0.4);
    expect(scoreOfWdl({ w: 0, d: 0, l: 0 })).toBeNull();
  });

  it('formats countdowns and relative times', () => {
    expect(fmtCountdown(65_000)).toBe('1:05');
    expect(fmtCountdown(3_723_000)).toBe('1:02:03');
    expect(fmtCountdown(-5)).toBe('0:00');
    const now = Date.UTC(2026, 0, 10);
    expect(fmtRelative(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(fmtRelative(now - 86_400_000, now)).toBe('yesterday');
    expect(fmtRelative(now - 10_000, now)).toBe('just now');
    expect(fmtRelative(null, now)).toBe('never');
  });

  it('formats time controls', () => {
    expect(fmtTimeControl('180+2')).toBe('3+2');
    expect(fmtTimeControl('600')).toBe('10+0');
    expect(fmtTimeControl('30+0')).toBe('½+0');
    expect(fmtTimeControl('15+0')).toBe('¼+0');
    expect(fmtTimeControl('1/259200')).toBe('3 days');
    expect(fmtTimeControl('1/86400')).toBe('1 day');
    expect(fmtTimeControl(null)).toBe('–');
    expect(fmtTimeControl('-')).toBe('–');
  });

  it('gives today in a time zone', () => {
    const t = Date.UTC(2026, 10, 20, 23, 30);
    expect(isoToday('UTC', t)).toBe('2026-11-20');
    expect(isoToday('Asia/Tokyo', t)).toBe('2026-11-21');
  });
});

describe('lines', () => {
  it('turns UCI lines into numbered SAN, with standard castling', () => {
    expect(lineToSanMoves('e2e4,e7e5,g1f3,b8c6,f1c4,g8f6,e1g1')).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']);
    expect(fmtLine(['e2e4', 'c7c5', 'g1f3'])).toBe('1. e4 c5 2. Nf3');
    expect(numberedSan(['d4'])).toBe('1. d4');
    // An illegal line falls back to the raw moves.
    expect(lineToSanMoves(['e2e5'])).toBeNull();
    expect(fmtLine(['e2e5'])).toBe('e2e5');
  });

  it('parses typed moves into a UCI line', () => {
    expect(parseMovesInput('1. e4 c5 2. Nf3')).toEqual({ line: ['e2e4', 'c7c5', 'g1f3'] });
    expect(parseMovesInput('e4 e5 Nf3 Nc6 Bc4 Nf6 O-O')).toEqual({ line: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1'] });
    expect(parseMovesInput('1.d4 Nf6 2.c4!? g6 3.Nc3 Bg7 *')).toEqual({ line: ['d2d4', 'g8f6', 'c2c4', 'g7g6', 'b1c3', 'f8g7'] });
    expect(parseMovesInput('e2e4 e7e5')).toEqual({ line: ['e2e4', 'e7e5'] });
    expect(parseMovesInput('e4 e5 Nf3 Nc6 Bc4 Nf6 0-0')).toMatchObject({ line: expect.arrayContaining(['e1g1']) });
    expect(parseMovesInput('1. e4 e5 2. Ke2 Ke7')).toEqual({ line: ['e2e4', 'e7e5', 'e1e2', 'e8e7'] });
    expect(parseMovesInput('1. e4 e4')).toEqual({ error: 'Illegal or unknown move: e4' });
    expect(parseMovesInput('   ')).toEqual({ error: 'Enter some moves' });
    expect('error' in parseMovesInput(Array.from({ length: 26 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' '))).toBe(true);
  });
});

describe('links', () => {
  it('links games and the explorer into the Studio', () => {
    expect(studioGameLink(123)).toBe('/studio?game=op123');
    const href = studioExplorerLink('magnus', 'black', { tc: ['blitz'], line: ['e2e4', 'c7c5'] }, true);
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/studio');
    expect(url.searchParams.get('explorer')).toBe('player:magnus');
    expect(url.searchParams.get('color')).toBe('black');
    expect(url.searchParams.get('embed')).toBe('explorer');
    expect(url.searchParams.get('pgn')).toBe('1. e4 c5');
    // The line sets up the board; it is not an explorer restriction.
    expect(decodeFiltersSegment(url.searchParams.get('filters')!)).toEqual({ tc: ['blitz'] });
    // An illegal line is dropped rather than sent.
    const bad = new URL(studioExplorerLink('magnus', 'white', { line: ['e2e5'] }, true), 'http://x');
    expect(bad.searchParams.has('pgn')).toBe(false);
    expect(bad.searchParams.get('filters')).toBe('_');
    const plain = new URL(studioExplorerLink('magnus', 'white', {}, false), 'http://x');
    expect(plain.searchParams.get('filters')).toBe('_');
    expect(plain.searchParams.has('embed')).toBe(false);
    expect(plain.searchParams.has('pgn')).toBe(false);
  });

  it('opens the Explorer tab at a line with the other filters kept', () => {
    expect(explorerTabAt('magnus', { tc: ['rapid'], line: ['d2d4'] }, 'white', ['e2e4', 'e7e5'])).toBe(
      '/u/magnus/explorer?color=white&tc=rapid&line=e2e4%2Ce7e5',
    );
  });
});

describe('filters description', () => {
  it('describes each active filter and clears it alone', () => {
    const f = { color: 'white', period: '30d', tc: ['blitz', 'rapid'], src: [12], outcome: ['w', 'l'], opp: '100', oppName: 'bob', line: ['e2e4'] } as const;
    const active = describeFilters({ ...f, tc: [...f.tc], src: [...f.src], outcome: [...f.outcome], line: [...f.line] }, { sources: [] });
    expect(active.map(a => a.label)).toEqual(['As White', 'Last 30 days', 'Blitz, Rapid', '#12', 'Wins, Losses', 'Stronger by 100+', 'vs bob', '1. e4']);
    const tc = active.find(a => a.key === 'tc')!;
    expect(tc.clear({ color: 'black', tc: ['blitz'] })).toEqual({ color: 'black' });
    expect(describeFilters({ from: '2026-01-01' }).map(a => a.label)).toEqual(['2026-01-01 → …']);
    expect(describeFilters({})).toEqual([]);
  });
});

describe('chart helpers', () => {
  it('bins magnitudes and scores', () => {
    expect(seqBin(0, 10)).toBe(0);
    expect(seqBin(10, 10)).toBe(5);
    expect(seqBin(1, 100)).toBe(1);
    expect(seqBin(5, 0)).toBe(0);
    expect(scoreBin(null)).toBeNull();
    expect(scoreBin(0)).toBe(0);
    expect(scoreBin(0.5)).toBe(3);
    expect(scoreBin(0.55)).toBe(3);
    expect(scoreBin(0.56)).toBe(4);
    expect(scoreBin(1)).toBe(6);
  });

  it('draws columns with a square base', () => {
    expect(columnPath(0, 10, 0, 20, 4)).toBe('M0,20V4Q0,0 4,0H6Q10,0 10,4V20Z');
    expect(columnPath(0, 10, 20, 20)).toBe('');
  });

  it('maps rating series to lines coloured by time class and dashed by account', () => {
    const sources = [
      { id: 1, displayName: 'li', kind: 'lichess' as const },
      { id: 2, displayName: 'cc', kind: 'chesscom' as const },
    ];
    const lines = toChartSeries(
      [
        { sourceId: 2, timeClass: 'blitz', points: [[1, 2000]] },
        { sourceId: 1, timeClass: 'bullet', points: [[1, 2100]] },
        { sourceId: 1, timeClass: 'blitz', points: [[1, 2050]] },
      ],
      sources,
    );
    expect(lines.map(l => l.key)).toEqual(['1:bullet', '1:blitz', '2:blitz']);
    expect(lines.map(l => l.label)).toEqual(['li · Bullet', 'li · Blitz', 'cc · Blitz']);
    expect(lines[1]!.color).toBe(lines[2]!.color);
    expect(lines[1]!.dash).not.toBe(lines[2]!.dash);
    expect(seriesKey({ sourceId: 3, timeClass: 'rapid' })).toBe('3:rapid');
    // One account: labels are just the time class.
    expect(toChartSeries([{ sourceId: 1, timeClass: 'rapid', points: [] }], sources)[0]!.label).toBe('Rapid');
  });

  it('picks the highest title', () => {
    expect(bestTitle([{ title: 'FM' }, { title: 'GM' }, { title: null }])).toBe('GM');
    expect(bestTitle([{ title: null }])).toBeNull();
  });
});
