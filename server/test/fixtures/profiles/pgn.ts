/** Synthetic PGN for the databases / files / prep tests (made-up players and events). */

export const RUY = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';
export const SICILIAN = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6';

export const pgnGame = (tags: Record<string, string>, moves: string, result = tags.Result ?? '*'): string =>
  `${Object.entries(tags)
    .map(([k, v]) => `[${k} "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
    .join('\n')}\n\n${moves} ${result}\n`;

/** Seven games: 2 good, 1 variant, 1 from a set-up position, 1 unfinished, 1 illegal, 1 duplicate of the first. */
export const MIXED_PGN = [
  pgnGame(
    {
      Event: 'Synthetic Club Championship',
      Site: 'Testville',
      Date: '2024.03.01',
      Round: '1',
      White: 'Åsen, Åse',
      Black: 'Berg, Bjørn',
      Result: '1-0',
      WhiteElo: '2100',
      BlackElo: '2000',
      TimeControl: '5400+30',
    },
    RUY,
  ),
  pgnGame(
    { Event: 'Synthetic Open', Site: 'Testville', Date: '2024.04.02', Round: '2', White: 'Berg, Bjørn', Black: 'Åsen, Åse', Result: '1/2-1/2' },
    SICILIAN,
  ),
  pgnGame({ Event: 'House rules', White: 'A', Black: 'B', Result: '1-0', Variant: 'Crazyhouse' }, '1. e4 e5'),
  pgnGame(
    { Event: 'Endgame drill', White: 'A', Black: 'B', Result: '1-0', SetUp: '1', FEN: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1' },
    '1. e4 Kd7',
  ),
  pgnGame({ Event: 'Adjourned', White: 'A', Black: 'B', Result: '*' }, '1. d4 d5'),
  pgnGame({ Event: 'Broken', White: 'A', Black: 'B', Result: '0-1' }, '1. e4 e5 2. Ke3'),
  pgnGame(
    {
      Event: 'Synthetic Club Championship',
      Site: 'Testville',
      Date: '2024.03.01',
      Round: '1',
      White: 'Åsen, Åse',
      Black: 'Berg, Bjørn',
      Result: '1-0',
    },
    RUY,
  ),
].join('\n');

/** A study with variations: the Ruy Lopez (after 3. Bb5) is only in a sideline; a second game starts 1. d4. */
export const STUDY_PGN = `[Event "Repertoire"]
[Result "*"]

1. e4 c5 (1... e5 2. Nf3 Nc6 3. Bb5 { Ruy } a6) 2. Nf3 d6 (2... Nc6 3. d4) 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 *

[Event "Second game"]
[Result "*"]

1. d4 d5 2. c4 *
`;
