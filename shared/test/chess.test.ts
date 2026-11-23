import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { describe, expect, it } from 'vitest';
import {
  chesscomOutcome,
  chesscomResult,
  chesscomTermination,
  chesscomTimeClass,
  epdOf,
  isKnownChesscomCode,
  lichessResult,
  lichessSpeedToTimeClass,
  lichessStatusToTermination,
  outcomeFor,
  parseResult,
  parseStdUci,
  parseTimeControl,
  playerKey,
  resultFromWinner,
  scoreOf,
  scoreRate,
  stdUci,
  timeClassFromClock,
  timeClassFromTimeControl,
} from '../src/chess.ts';

const play = (sans: string[]): Chess => {
  const pos = Chess.default();
  for (const san of sans) {
    const m = parseSan(pos, san);
    if (!m) throw new Error(`illegal ${san}`);
    pos.play(m);
  }
  return pos;
};

describe('time classes', () => {
  it('maps Lichess speeds, folding UltraBullet into bullet', () => {
    expect(lichessSpeedToTimeClass('ultraBullet')).toBe('bullet');
    expect(lichessSpeedToTimeClass('bullet')).toBe('bullet');
    expect(lichessSpeedToTimeClass('blitz')).toBe('blitz');
    expect(lichessSpeedToTimeClass('rapid')).toBe('rapid');
    expect(lichessSpeedToTimeClass('classical')).toBe('classical');
    expect(lichessSpeedToTimeClass('correspondence')).toBe('correspondence');
    expect(lichessSpeedToTimeClass('chess960')).toBe('unknown');
    expect(lichessSpeedToTimeClass(undefined)).toBe('unknown');
  });

  it('maps Chess.com time_class, daily as correspondence', () => {
    expect(chesscomTimeClass('daily')).toBe('correspondence');
    expect(chesscomTimeClass('rapid')).toBe('rapid');
    expect(chesscomTimeClass('blitz')).toBe('blitz');
    expect(chesscomTimeClass('bullet')).toBe('bullet');
    expect(chesscomTimeClass('classical')).toBe('unknown');
  });

  it('parses PGN time controls', () => {
    expect(parseTimeControl('180+2')).toEqual({ initial: 180, increment: 2 });
    expect(parseTimeControl('600')).toEqual({ initial: 600, increment: 0 });
    expect(parseTimeControl('1/259200')).toBe('correspondence');
    expect(parseTimeControl('-')).toBeNull();
    expect(parseTimeControl('?')).toBeNull();
    expect(parseTimeControl('40/7200:3600')).toBeNull();
    expect(parseTimeControl(undefined)).toBeNull();
  });

  it('classifies clocks with Lichess thresholds', () => {
    expect(timeClassFromClock({ initial: 15, increment: 0 })).toBe('bullet');
    expect(timeClassFromClock({ initial: 60, increment: 1 })).toBe('bullet');
    expect(timeClassFromClock({ initial: 180, increment: 0 })).toBe('blitz');
    expect(timeClassFromClock({ initial: 300, increment: 3 })).toBe('blitz');
    expect(timeClassFromClock({ initial: 300, increment: 5 })).toBe('rapid');
    expect(timeClassFromClock({ initial: 600, increment: 0 })).toBe('rapid');
    expect(timeClassFromClock({ initial: 1500, increment: 0 })).toBe('classical');
    expect(timeClassFromTimeControl('5400+30')).toBe('classical');
    expect(timeClassFromTimeControl('1/86400')).toBe('correspondence');
    expect(timeClassFromTimeControl(null)).toBe('unknown');
  });
});

describe('results and outcomes', () => {
  it('parses PGN results', () => {
    expect(parseResult('1-0')).toBe('1-0');
    expect(parseResult('0-1')).toBe('0-1');
    expect(parseResult('1/2-1/2')).toBe('1/2-1/2');
    expect(parseResult('½-½')).toBe('1/2-1/2');
    expect(parseResult('*')).toBeNull();
  });

  it('computes outcomes per colour', () => {
    expect(outcomeFor('1-0', 'white')).toBe('w');
    expect(outcomeFor('1-0', 'black')).toBe('l');
    expect(outcomeFor('0-1', 'black')).toBe('w');
    expect(outcomeFor('1/2-1/2', 'white')).toBe('d');
    expect(resultFromWinner('black')).toBe('0-1');
    expect(resultFromWinner(null)).toBe('1/2-1/2');
  });

  it('scores', () => {
    expect(scoreOf('w')).toBe(1);
    expect(scoreOf('d')).toBe(0.5);
    expect(scoreOf('l')).toBe(0);
    expect(scoreRate({ w: 2, d: 2, l: 0 })).toBe(0.75);
    expect(scoreRate({ w: 0, d: 0, l: 0 })).toBeNull();
  });
});

describe('Lichess status', () => {
  it('maps statuses to terminations', () => {
    expect(lichessStatusToTermination('mate', 'white')).toBe('mate');
    expect(lichessStatusToTermination('resign', 'black')).toBe('resign');
    expect(lichessStatusToTermination('outoftime', 'white')).toBe('timeout');
    expect(lichessStatusToTermination('outoftime', undefined)).toBe('timeout_vs_insufficient');
    expect(lichessStatusToTermination('timeout', 'white')).toBe('abandon');
    expect(lichessStatusToTermination('draw', undefined)).toBe('agreement');
    expect(lichessStatusToTermination('stalemate', undefined)).toBe('stalemate');
    expect(lichessStatusToTermination('insufficientMaterialClaim', undefined)).toBe('insufficient');
    expect(lichessStatusToTermination('cheat', 'white')).toBe('other');
  });

  it('derives results and skips unfinished games', () => {
    expect(lichessResult('mate', 'white')).toBe('1-0');
    expect(lichessResult('draw', undefined)).toBe('1/2-1/2');
    expect(lichessResult('aborted', undefined)).toBeNull();
    expect(lichessResult('started', undefined)).toBeNull();
  });
});

describe('Chess.com result codes', () => {
  it('classifies each player code as W/D/L', () => {
    expect(chesscomOutcome('win')).toBe('w');
    for (const c of ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'])
      expect(chesscomOutcome(c)).toBe('d');
    for (const c of ['checkmated', 'timeout', 'resigned', 'lose', 'abandoned', 'kingofthehill', 'threecheck'])
      expect(chesscomOutcome(c)).toBe('l');
    expect(chesscomOutcome('something-new')).toBe('l');
    expect(isKnownChesscomCode('something-new')).toBe(false);
    expect(isKnownChesscomCode('50move')).toBe(true);
  });

  it('derives the game result and termination from both codes', () => {
    expect(chesscomResult('win', 'checkmated')).toBe('1-0');
    expect(chesscomTermination('win', 'checkmated')).toBe('mate');
    expect(chesscomResult('resigned', 'win')).toBe('0-1');
    expect(chesscomTermination('resigned', 'win')).toBe('resign');
    expect(chesscomTermination('win', 'timeout')).toBe('timeout');
    expect(chesscomTermination('abandoned', 'win')).toBe('abandon');
    expect(chesscomTermination('win', 'lose')).toBe('other');
    expect(chesscomResult('agreed', 'agreed')).toBe('1/2-1/2');
    expect(chesscomTermination('agreed', 'agreed')).toBe('agreement');
    expect(chesscomTermination('repetition', 'repetition')).toBe('repetition');
    expect(chesscomTermination('stalemate', 'stalemate')).toBe('stalemate');
    expect(chesscomTermination('insufficient', 'insufficient')).toBe('insufficient');
    expect(chesscomTermination('50move', '50move')).toBe('fifty');
    expect(chesscomTermination('timevsinsufficient', 'timevsinsufficient')).toBe('timeout_vs_insufficient');
    expect(chesscomResult('win', 'win')).toBeNull();
  });
});

describe('UCI and positions', () => {
  it('writes castling in standard notation (e1g1), not king-takes-rook', () => {
    const pos = play(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const castle = parseSan(pos, 'O-O')!;
    expect(stdUci(pos, castle)).toBe('e1g1');
    const normal = parseSan(pos, 'd3')!;
    expect(stdUci(pos, normal)).toBe('d2d3');
  });

  it('parses both castling notations back to a legal move', () => {
    const pos = play(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const a = parseStdUci(pos, 'e1g1');
    const b = parseStdUci(pos, 'e1h1');
    expect(a).toBeDefined();
    expect(a).toEqual(b);
    expect(parseStdUci(pos, 'e1e3')).toBeUndefined();
    expect(parseStdUci(pos, 'zz')).toBeUndefined();
  });

  it('builds EPD keys that only include a legal en-passant square', () => {
    expect(epdOf(play(['e4']))).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    // Transposition: 1.Nf3 Nf6 2.c4 and 1.c4 Nf6 2.Nf3 reach the same key.
    expect(epdOf(play(['Nf3', 'Nf6', 'c4']))).toBe(epdOf(play(['c4', 'Nf6', 'Nf3'])));
    const ep = Chess.fromSetup(
      parseFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3').unwrap(),
    ).unwrap();
    expect(epdOf(ep).endsWith(' e3')).toBe(true);
  });

  it('normalises player keys', () => {
    expect(playerKey('  DrNykterstein ')).toBe('drnykterstein');
  });
});
