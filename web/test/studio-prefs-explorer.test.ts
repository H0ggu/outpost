/**
 * Studio look preferences (src/studio/prefs.ts) and lila's explorer options (src/studio/explorer.ts):
 * endpoints, the filtered player database, labels, player search and auth.
 */
import { DEFAULT_PREFS } from '@outpost/shared/api';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackPlayerLabel, makeExplorerOpts, type ExplorerDeps } from '../src/studio/explorer.ts';
import { applyPieces, applyStudioPrefs, localPrefs, PREFS_STORAGE_KEY, sanitizePrefs, savePrefs } from '../src/studio/prefs.ts';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('prefs', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to true black and lila’s board, and drops unknown values', () => {
    expect(sanitizePrefs(null)).toEqual({ theme: 'black', boardTheme: 'brown', pieceSet: 'cburnett', soundSet: 'sfx', studioLayout: 'default' });
    expect(sanitizePrefs({ theme: 'neon', boardTheme: 'blue', pieceSet: 'alpha', soundSet: 'standard', studioLayout: 'focus' })).toEqual({
      theme: DEFAULT_PREFS.theme,
      boardTheme: 'blue',
      pieceSet: 'cburnett',
      soundSet: 'sfx',
      studioLayout: 'focus',
    });
  });

  it('reads this browser’s prefs, preferring the site-wide theme', () => {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'dark', pieceSet: 'merida' }));
    expect(localPrefs()).toMatchObject({ theme: 'dark', pieceSet: 'merida' });
    localStorage.setItem('outpost.theme', 'light');
    expect(localPrefs().theme).toBe('light');
    localStorage.setItem(PREFS_STORAGE_KEY, '{oops');
    expect(localPrefs().pieceSet).toBe('cburnett');
  });

  it('applies the look the way lila reads it', () => {
    const changeSet = vi.fn();
    (window as unknown as { site?: unknown }).site = { sound: { changeSet } };
    applyStudioPrefs({ theme: 'light', boardTheme: 'green', pieceSet: 'merida', soundSet: 'piano', studioLayout: 'games' });
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light');
    expect(root.classList.contains('light')).toBe(true);
    expect(document.body.dataset.board).toBe('green');
    expect(document.body.dataset.soundSet).toBe('piano');
    expect(document.body.dataset.studioLayout).toBe('games');
    // unquoted: lila's loadPieces strips `url(` and `)` to preload the images
    expect(document.body.style.getPropertyValue('---white-knight')).toBe('url(/lichess/piece/merida/wN.svg)');
    expect(changeSet).toHaveBeenCalledWith('piano');
    applyStudioPrefs({ ...DEFAULT_PREFS });
    expect(root.classList.contains('light')).toBe(false);
    expect(root.classList.contains('dark')).toBe(true);
    applyPieces('pixel', document.documentElement);
    expect(document.documentElement.style.getPropertyValue('---black-king')).toBe('url(/lichess/piece/pixel/bK.svg)');
    delete (window as unknown as { site?: unknown }).site;
  });

  it('saves to the account when signed in, and always in this browser', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...DEFAULT_PREFS, boardTheme: 'olive' }));
    vi.stubGlobal('fetch', fetchMock);
    const next = { ...sanitizePrefs(null), boardTheme: 'olive' as const };
    await savePrefs(next, { boardTheme: 'olive' }, false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY)!).boardTheme).toBe('olive');
    await savePrefs(next, { boardTheme: 'olive' }, true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me/prefs');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ boardTheme: 'olive' });
  });
});

describe('explorer options', () => {
  afterEach(() => vi.unstubAllGlobals());

  const deps = (over: Partial<ExplorerDeps> = {}): ExplorerDeps => ({
    origin: 'https://chess.example.com',
    signedIn: () => true,
    anonymousBrowsing: () => false,
    hasLichessToken: () => true,
    isAdmin: () => false,
    loginUrl: () => '/login?next=%2Fstudio',
    redraw: vi.fn(),
    openGame: vi.fn(),
    showGames: vi.fn(),
    playerPerspective: () => true,
    ...over,
  });

  it('uses absolute endpoints, and the filters segment only for the profile it was opened with', () => {
    const segment = encodeFiltersSegment({ color: 'white', tc: ['blitz'] });
    const o = makeExplorerOpts(deps({ filtered: { player: 'hikaru', segment } }));
    expect(o.endpoint).toBe('https://chess.example.com/api/explorer/');
    expect(new URL('./masters', o.endpoint).href).toBe('https://chess.example.com/api/explorer/masters');
    expect(o.tablebaseEndpoint).toBe('/api/tablebase');
    const base = o.outpost.playerEndpoint('hikaru');
    expect(new URL('./player', base).href).toBe(`https://chess.example.com/api/explorer/f/${segment}/player`);
    expect(o.outpost.playerEndpoint('lichess:drnykterstein')).toBe('https://chess.example.com/api/explorer/');
    expect(o.outpost.loginUrl).toBe('/login?next=%2Fstudio');
  });

  it('needs a session unless anonymous browsing is on', () => {
    let signedIn = false;
    let anon = false;
    const o = makeExplorerOpts(deps({ signedIn: () => signedIn, anonymousBrowsing: () => anon }));
    expect(o.outpost.requiresAuth()).toBe(true);
    anon = true;
    expect(o.outpost.requiresAuth()).toBe(false);
    anon = false;
    signedIn = true;
    expect(o.outpost.requiresAuth()).toBe(false);
  });

  it("hands lila the games list and the viewer's W/D/L perspective, read when asked", () => {
    let player = true;
    const showGames = vi.fn();
    const o = makeExplorerOpts(deps({ showGames, playerPerspective: () => player }));
    expect(o.outpost.playerPerspective()).toBe(true);
    player = false;
    expect(o.outpost.playerPerspective()).toBe(false);
    const req = { player: 'hikaru', color: 'white' as const, rootFen: 'x', play: [], fen: 'x', speeds: [], modes: [], since: '', until: '', total: 3 };
    o.outpost.showGames(req);
    expect(showGames).toHaveBeenCalledWith(req);
  });

  it('explains the Lichess database instead of asking for it when the server has no token', () => {
    let token: boolean | undefined = undefined;
    let admin = false;
    const o = makeExplorerOpts(deps({ hasLichessToken: () => token, isAdmin: () => admin }));
    expect(o.outpost.unavailable('lichess')).toBeUndefined(); // unknown: the server decides
    token = true;
    expect(o.outpost.unavailable('lichess')).toBeUndefined();
    token = false;
    expect(o.outpost.unavailable('lichess')).toMatch(/Lichess API token, and none is set\. Ask the admin/);
    admin = true;
    expect(o.outpost.unavailable('lichess')).toMatch(/Add a personal token in Admin → Settings/);
    for (const db of ['masters', 'reference', 'player'] as const) expect(o.outpost.unavailable(db)).toBeUndefined();
  });

  it('labels player specs, learning profile names from the server', async () => {
    expect(fallbackPlayerLabel('lichess:DrNykterstein')).toBe('drnykterstein (Lichess)'); // specs are lowercase (parsePlayerSpec)
    expect(fallbackPlayerLabel('chesscom:hikaru')).toBe('hikaru (Chess.com)');
    expect(fallbackPlayerLabel('db:4')).toBe('Database 4');
    expect(fallbackPlayerLabel('ref:1503014')).toBe('FIDE 1503014');
    expect(fallbackPlayerLabel('Not valid')).toBe('Not valid');
    const fetchMock = vi.fn(async () => jsonResponse({ slug: 'hikaru', displayName: 'Hikaru Nakamura' }));
    vi.stubGlobal('fetch', fetchMock);
    const d = deps();
    const o = makeExplorerOpts(d);
    expect(o.outpost.playerLabel('hikaru')).toBe('hikaru');
    await new Promise(r => setTimeout(r, 0));
    expect(o.outpost.playerLabel('hikaru')).toBe('Hikaru Nakamura');
    expect(d.redraw).toHaveBeenCalled();
    o.outpost.playerLabel('hikaru');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('searches profiles, known accounts and reference players', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          profiles: [{ slug: 'hikaru', displayName: 'Hikaru Nakamura' }],
          lichess: [
            { kind: 'lichess', username: 'DrNykterstein', known: true, profileSlug: null },
            { kind: 'lichess', username: 'Unknown', known: false, profileSlug: null },
            { kind: 'lichess', username: 'Linked', known: true, profileSlug: 'linked' },
          ],
          chesscom: [{ kind: 'chesscom', username: 'Hikaru', known: true, profileSlug: null }],
          reference: [{ name: 'Carlsen, Magnus', fideId: '1503014', profileSlug: null }],
        }),
      ),
    );
    const o = makeExplorerOpts(deps());
    expect(await o.outpost.searchPlayers(' h')).toEqual([]);
    expect(await o.outpost.searchPlayers('hik')).toEqual([
      { spec: 'hikaru', label: 'Hikaru Nakamura', hint: 'profile' },
      { spec: 'lichess:drnykterstein', label: 'DrNykterstein', hint: 'Lichess' },
      { spec: 'chesscom:hikaru', label: 'Hikaru', hint: 'Chess.com' },
      { spec: 'ref:1503014', label: 'Carlsen, Magnus', hint: 'reference DB' },
    ]);
  });

  it('suggests bookmarks, own profiles and readable PGN databases once, when signed in', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/api/databases')
        ? jsonResponse({
            databases: [
              { id: 7, name: 'Club games', kind: 'games', gameCount: 120, canEdit: true },
              { id: 8, name: 'Shared archive', kind: 'games', gameCount: 40, canEdit: false },
              { id: 9, name: 'Empty', kind: 'games', gameCount: 0, canEdit: true },
            ],
          })
        : jsonResponse({ profiles: url.includes('bookmarks') ? [{ slug: 'a', displayName: 'A' }] : [{ slug: 'a', displayName: 'A' }, { slug: 'b', displayName: 'B' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const o = makeExplorerOpts(deps());
    expect(o.outpost.suggestedPlayers()).toEqual([]);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(o.outpost.suggestedPlayers()).toEqual([
      { spec: 'a', label: 'A', hint: 'bookmarked' },
      { spec: 'b', label: 'B', hint: 'mine' },
      // "My DBs": the player explorer reads a database as db:<id>.
      { spec: 'db:7', label: 'Club games', hint: 'my database' },
      { spec: 'db:8', label: 'Shared archive', hint: 'database' },
    ]);
    expect(o.outpost.playerLabel('db:7')).toBe('Club games');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const anon = makeExplorerOpts(deps({ signedIn: () => false }));
    anon.outpost.suggestedPlayers();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('redraws a player dialog that opened before the suggestions arrived', async () => {
    let answer!: () => void;
    const gate = new Promise<void>(r => (answer = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await gate;
        return jsonResponse({ profiles: url.includes('bookmarks') ? [{ slug: 'a', displayName: 'A' }] : [] });
      }),
    );
    const d = deps();
    const o = makeExplorerOpts(d);
    const firstDialog = vi.fn();
    const reopened = vi.fn();
    expect(o.outpost.suggestedPlayers(firstDialog)).toEqual([]); // first open: still loading
    expect(o.outpost.suggestedPlayers(firstDialog)).toEqual([]); // the same dialog redrawn
    expect(o.outpost.suggestedPlayers(reopened)).toEqual([]); // closed and opened again meanwhile
    answer();
    await vi.waitFor(() => expect(firstDialog).toHaveBeenCalledTimes(1));
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(d.redraw).toHaveBeenCalled();
    expect(o.outpost.suggestedPlayers(firstDialog)).toEqual([{ spec: 'a', label: 'A', hint: 'bookmarked' }]);
    expect(firstDialog).toHaveBeenCalledTimes(1); // loaded: no more redraws asked for
    const anon = makeExplorerOpts(deps({ signedIn: () => false }));
    const anonDialog = vi.fn();
    anon.outpost.suggestedPlayers(anonDialog);
    await new Promise(r => setTimeout(r, 0));
    expect(anonDialog).not.toHaveBeenCalled();
  });
});
