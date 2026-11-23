import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseInfo, DbGameRow, JobInfo } from '@outpost/shared/api';
import { importCountItems, importOutcome, importSummaryText } from '../src/app/pages/components/library/ImportPanel.tsx';
import DatabasePage, { GameActions } from '../src/app/pages/DatabasePage.tsx';
import DatabasesPage from '../src/app/pages/DatabasesPage.tsx';
import { POLL } from '../src/app/pages/library-hooks.ts';
import { apiError, database, header, job, profile, renderPage, session, USER, withFakeServer } from './web-library-helpers.tsx';

const api = withFakeServer();

const saved = POLL.importMs;
beforeAll(() => {
  POLL.importMs = 30;
});
afterAll(() => {
  POLL.importMs = saved;
});

function dbGame(id: number, over: Partial<DbGameRow> = {}): DbGameRow {
  return {
    id,
    origin: 'pgn',
    url: null,
    white: { name: `White ${id}`, rating: 2100, title: null },
    black: { name: `Black ${id}`, rating: 2050, title: 'FM' },
    result: '1/2-1/2',
    termination: 'agreement',
    timeClass: 'classical',
    event: 'Club ch',
    round: '3',
    endedAt: Date.UTC(2026, 10, 1),
    plies: 81,
    eco: 'C65',
    openingName: 'Ruy Lopez: Berlin Defense',
    ...over,
  };
}

describe('DatabasesPage', () => {
  it('groups mine, shared and reference databases', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/databases', {
        databases: [
          database({ id: 1, name: 'Mine A', importJob: job({ status: 'running', queuePosition: 0 }) }),
          database({ id: 2, name: 'Theirs', owner: { id: 3, username: 'carol' }, visibility: 'public', canEdit: false }),
          database({ id: 3, name: 'Broadcasts', kind: 'reference', owner: null, licence: 'CC BY-SA 4.0', canEdit: false, gameCount: 123456 }),
        ],
      });
    renderPage(<DatabasesPage />, { route: '/databases' });
    const mine = (await screen.findByText('My databases')).closest('section')!;
    expect(within(mine).getByRole('link', { name: 'Mine A' }).getAttribute('href')).toBe('/databases/1');
    expect(within(mine).getByText('importing')).toBeTruthy();
    const shared = screen.getByText('Shared by others').closest('section')!;
    expect(within(shared).getByText('carol')).toBeTruthy();
    const ref = screen.getByText('Reference databases').closest('section')!;
    expect(within(ref).getByText('CC BY-SA 4.0')).toBeTruthy();
    expect(within(ref).getByText('123,456')).toBeTruthy();
  });

  it('creates a database and opens it', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/databases', { databases: [] })
      .on('POST', '/api/databases', database({ id: 42, name: 'New one' }));
    const { location } = renderPage(<DatabasesPage />, { route: '/databases' });
    expect(await screen.findByText('No databases yet')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New database' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Give the database a name.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New one' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'public' } });
    fireEvent.change(screen.getByLabelText('Licence (optional)'), { target: { value: 'CC0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(location()).toBe('/databases/42'));
    expect(api().find('POST', '/api/databases')[0]!.body).toEqual({ name: 'New one', visibility: 'public', licence: 'CC0' });
  });

  it('toggles visibility of my database', async () => {
    let db = database({ id: 1, name: 'Mine A' });
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/databases', () => ({ databases: [db] }))
      .on('PATCH', '/api/databases/1', req => {
        db = { ...db, ...(req.body as Partial<DatabaseInfo>) };
        return db;
      });
    renderPage(<DatabasesPage />, { route: '/databases' });
    fireEvent.click(await screen.findByRole('button', { name: 'Mine A is private; make it public' }));
    expect(await screen.findByRole('button', { name: 'Mine A is public; make it private' })).toBeTruthy();
    expect(api().find('PATCH', '/api/databases/1')[0]!.body).toEqual({ visibility: 'public' });
  });
});

describe('DatabasesPage errors', () => {
  it('says when a visibility change failed', async () => {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/databases', { databases: [database({ id: 1, name: 'Mine A' })] })
      .on('PATCH', '/api/databases/1', apiError(500, 'internal', 'disk full'));
    renderPage(<DatabasesPage />, { route: '/databases' });
    fireEvent.click(await screen.findByRole('button', { name: 'Mine A is private; make it public' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not make Mine A public: disk full');
    expect(screen.getByRole('button', { name: 'Mine A is private; make it public' })).toBeTruthy();
  });
});

describe('DatabasePage', () => {
  const ROUTE = { route: '/databases/:id', path: '/databases/5' };

  function base(db: () => DatabaseInfo, games: DbGameRow[] = [dbGame(1), dbGame(2)]) {
    api()
      .on('GET', '/api/session', session(USER))
      .on('GET', '/api/databases/5', () => db())
      .on('GET', '/api/databases/5/games', req => {
        const q = req.query.get('q') ?? '';
        const page = Number(req.query.get('page') ?? 1);
        const rows = games.filter(g => !q || g.white.name.includes(q) || g.black.name.includes(q));
        return { total: rows.length, page, pageSize: 50, games: rows.slice((page - 1) * 50, page * 50) };
      })
      .on('GET', '/api/profiles', { profiles: [profile({ displayName: 'My Profile', slug: 'mine' })] });
  }

  it('shows the games, links them to the Studio, searches and pages', async () => {
    const games = Array.from({ length: 120 }, (_, i) => dbGame(i + 1));
    base(() => database({ gameCount: 120 }), games);
    const { location } = renderPage(<DatabasePage />, ROUTE);
    expect(await screen.findByRole('heading', { name: /Club games/ })).toBeTruthy();
    expect(await screen.findByText('White 1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Analyse White 1 vs Black 1' }).getAttribute('href')).toBe('/studio?game=1');
    expect(screen.getByRole('link', { name: 'Export PGN' }).getAttribute('href')).toBe('/api/databases/5/export.pgn');
    expect(screen.getByRole('link', { name: 'Explore' }).getAttribute('href')).toBe('/studio?explorer=player%3Adb%3A5&color=white');
    expect(screen.getAllByText('½-½').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() => expect(location()).toBe('/databases/5?page=3'));
    expect(await screen.findByText('White 101')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3' }).getAttribute('aria-current')).toBe('page');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search games' }), { target: { value: 'White 7' } });
    await waitFor(() => expect(location()).toBe('/databases/5?q=White+7'));
    expect(await screen.findByText('White 77')).toBeTruthy();
    expect(screen.getByText('11 matching')).toBeTruthy();
  });

  it('deletes a game after confirmation', async () => {
    let games = [dbGame(1), dbGame(2)];
    api().on('DELETE', '/api/databases/5/games/1', () => {
      games = games.slice(1);
      return { ok: true };
    });
    base(() => database({ gameCount: games.length }), games);
    api().on('GET', '/api/databases/5/games', () => ({ total: games.length, page: 1, pageSize: 50, games }));
    renderPage(<DatabasePage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete White 1 vs Black 1' }));
    expect(api().find('DELETE', '/api/databases/5/games/1')).toHaveLength(0);
    // Armed: the row offers confirm and cancel in place of its two icons.
    expect(screen.queryByRole('link', { name: 'Analyse White 1 vs Black 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('link', { name: 'Analyse White 1 vs Black 1' })).toBeTruthy();
    expect(api().find('DELETE', '/api/databases/5/games/1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete White 1 vs Black 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: delete White 1 vs Black 1' }));
    await waitFor(() => expect(screen.queryByText('White 1')).toBeNull());
    expect(api().find('DELETE', '/api/databases/5/games/1')).toHaveLength(1);
  });

  it('imports pasted PGN, follows the job and summarises it', async () => {
    const running = (done: number, counts: Record<string, number>) =>
      job({ id: 77, status: 'running', queuePosition: 0, progress: { done, total: null, message: `Game ${done}`, counts } });
    // What GET /api/databases/:id answers over time: idle, then the job running, then gone (done).
    const states: DatabaseInfo[] = [];
    let current = database({ gameCount: 2 });
    base(() => (current = states.shift() ?? current));
    api().on('POST', '/api/databases/5/import', () => {
      states.push(
        database({ gameCount: 2, importJob: running(1, { imported: 1 }) }),
        database({ gameCount: 3, importJob: running(3, { imported: 2, duplicates: 1 }) }),
        database({ gameCount: 4 }),
      );
      return { job: job({ id: 77 }) };
    });
    renderPage(<DatabasePage />, ROUTE);
    fireEvent.click(await screen.findByRole('tab', { name: 'Paste PGN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByText('Paste some PGN first.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('PGN'), { target: { value: '[White "A"]\n[Black "B"]\n\n1. e4 e5 1-0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Importing games')).toBeTruthy();
    expect(api().find('POST', '/api/databases/5/import')[0]!.body).toEqual({ pgn: '[White "A"]\n[Black "B"]\n\n1. e4 e5 1-0' });
    const summary = await screen.findByText('Import finished: 2 games added', undefined, { timeout: 3000 });
    const box = summary.closest('[role=status]') as HTMLElement;
    expect(within(box).getByText('duplicates skipped')).toBeTruthy();
    expect(within(box).getByText('4')).toBeTruthy();
    // The games list was refreshed after the import.
    expect(api().find('GET', '/api/databases/5/games').length).toBeGreaterThan(1);
    fireEvent.click(within(box).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Import finished: 2 games added')).toBeNull();
  });

  it('summarises from the final counters (lastImport) and shows the last import when idle', async () => {
    const final = job({
      id: 90,
      status: 'done',
      finishedAt: Date.now() - 5000,
      progress: { done: 12, total: null, message: null, counts: { imported: 9, duplicates: 1, skipped: 2, 'skip:variant': 1, 'skip:noResult': 1 } },
    });
    const states: DatabaseInfo[] = [];
    let current = database({ gameCount: 2 });
    base(() => (current = states.shift() ?? current));
    api().on('POST', '/api/databases/5/import', () => {
      // The last progress seen while polling lags behind the end of the job.
      states.push(
        database({ gameCount: 3, importJob: job({ id: 90, status: 'running', queuePosition: 0, progress: { done: 2, total: null, message: null, counts: { imported: 1 } } }) }),
        database({ gameCount: 11, importJob: null, lastImport: final }),
      );
      return { job: job({ id: 90 }) };
    });
    renderPage(<DatabasePage />, ROUTE);
    fireEvent.click(await screen.findByRole('tab', { name: 'Paste PGN' }));
    fireEvent.change(screen.getByLabelText('PGN'), { target: { value: '1. e4 e5 1-0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const summary = await screen.findByText('Import finished: 9 games added', undefined, { timeout: 3000 });
    const box = summary.closest('[role=status]') as HTMLElement;
    expect(within(box).getByText('skipped (1 variant, 1 unfinished)')).toBeTruthy();
    expect(within(box).getByText('duplicates skipped')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByText(/Last import .*: 9 imported, 1 duplicates skipped, 2 skipped \(1 variant, 1 unfinished\)\./)).toBeTruthy();
  });

  it('uploads a .pgn file as multipart and refuses oversized files', async () => {
    base(() => database());
    api().on('POST', '/api/databases/5/import', { job: job({ id: 78, status: 'error', error: 'Not a PGN file' }) });
    renderPage(<DatabasePage />, ROUTE);
    const input = (await screen.findByText(/Drop a/)).closest('label')!.querySelector('input[type=file]') as HTMLInputElement;

    const big = new File(['x'], 'huge.pgn', { type: 'application/x-chess-pgn' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(screen.getByText(/the limit is 50 MB/)).toBeTruthy();

    const file = new File(['[White "A"]\n\n1. e4 *'], 'games.pgn', { type: 'application/x-chess-pgn' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('games.pgn')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api().find('POST', '/api/databases/5/import')).toHaveLength(1));
    const body = api().find('POST', '/api/databases/5/import')[0]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('games.pgn');
    // The job failed straight away: the summary says so.
    expect(await screen.findByText('Import failed')).toBeTruthy();
    expect(screen.getByText('Not a PGN file')).toBeTruthy();
  });

  it('renames, changes visibility and deletes the database', async () => {
    let db = database();
    base(() => db);
    api()
      .on('PATCH', '/api/databases/5', req => {
        db = { ...db, ...(req.body as Partial<DatabaseInfo>) };
        return db;
      })
      .on('DELETE', '/api/databases/5', { ok: true });
    const { location } = renderPage(<DatabasePage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Database name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: /Renamed/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make public' }));
    expect(await screen.findByRole('button', { name: 'Make private' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete database' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 games for good' }));
    await waitFor(() => expect(location()).toBe('/databases'));
  });

  it('does not refetch a database it just deleted', async () => {
    base(() => database());
    api().on('DELETE', '/api/databases/5', { ok: true });
    const { location, qc } = renderPage(<DatabasePage />, ROUTE);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete database' }));
    const before = api().find('GET', /^\/api\/databases\/5(\/games)?$/).length;
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 games for good' }));
    await waitFor(() => expect(location()).toBe('/databases'));
    await new Promise(r => setTimeout(r, 50));
    expect(api().find('GET', /^\/api\/databases\/5(\/games)?$/).length).toBe(before);
    // …and forgets it once its page is gone.
    await waitFor(() => expect(qc.getQueryCache().findAll({ queryKey: ['databases', 5] })).toHaveLength(0));
  });

  it('hides editing for read-only databases', async () => {
    base(() => database({ canEdit: false, owner: { id: 3, username: 'carol' } }));
    renderPage(<DatabasePage />, ROUTE);
    expect(await screen.findByText('White 1')).toBeTruthy();
    expect(screen.queryByText('Import games')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    // Anyone signed in can still attach a player.
    expect(screen.getByText('Attach a player to a profile')).toBeTruthy();
  });

  it('attaches a player to a new or existing profile', async () => {
    base(() => database());
    api().on('POST', '/api/profiles/mine/sources', header({ slug: 'mine', displayName: 'My Profile' }));
    renderPage(<DatabasePage />, ROUTE);
    const name = await screen.findByLabelText('Player name, as written in the PGN');
    fireEvent.change(name, { target: { value: 'White 1' } });
    expect(screen.getByRole('link', { name: 'New profile' }).getAttribute('href')).toBe('/profiles/new?db=5&player=White+1&name=White+1');
    const target = screen.getByLabelText('…or add to one of my profiles');
    await waitFor(() => expect(within(target).getByRole('option', { name: 'My Profile' })).toBeTruthy());
    fireEvent.change(target, { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to profile' }));
    expect(await screen.findByText(/Added “White 1” to/)).toBeTruthy();
    expect(api().find('POST', '/api/profiles/mine/sources')[0]!.body).toEqual({ kind: 'pgn', key: 'White 1', databaseId: 5 });
  });

  it('handles missing databases and bad ids', async () => {
    api().on('GET', '/api/session', session(USER)).on('GET', '/api/databases/5', apiError(404, 'not_found'));
    renderPage(<DatabasePage />, ROUTE);
    expect(await screen.findByText("This database doesn't exist, or it's private.")).toBeTruthy();
  });

  it('moves from a page past the end to the last page instead of saying "no games"', async () => {
    const games = Array.from({ length: 60 }, (_, i) => dbGame(i + 1));
    base(() => database({ gameCount: 60 }), games);
    const { location } = renderPage(<DatabasePage />, { route: '/databases/:id', path: '/databases/5?page=4' });
    await waitFor(() => expect(location()).toBe('/databases/5?page=2'));
    expect(await screen.findByText('White 51')).toBeTruthy();
    expect(screen.queryByText('No games yet')).toBeNull();
    expect(screen.queryByText(/is empty/)).toBeNull();
    // A one-page result goes back to the first page.
    const { location: loc2 } = renderPage(<DatabasePage />, { route: '/databases/:id', path: '/databases/5?page=3&q=White+7' });
    await waitFor(() => expect(loc2()).toBe('/databases/5?q=White+7'));
  });

  it('says a page is empty while it moves there', async () => {
    base(() => database({ gameCount: 60 }));
    // The server reports 60 games but returns none for any page (another tab deleting, say).
    api().on('GET', '/api/databases/5/games', req => ({ total: 60, page: Number(req.query.get('page') ?? 1), pageSize: 50, games: [] }));
    renderPage(<DatabasePage />, { route: '/databases/:id', path: '/databases/5' });
    expect(await screen.findByText('Page 1 is empty')).toBeTruthy();
    expect(screen.getByText('This database has 2 pages.')).toBeTruthy();
    expect(screen.queryByText('No games yet')).toBeNull();
    expect(screen.getByRole('button', { name: '2' })).toBeTruthy();
  });

  it('caps the search box at the server limit', async () => {
    base(() => database());
    renderPage(<DatabasePage />, ROUTE);
    expect((await screen.findByRole('searchbox', { name: 'Search games' })).getAttribute('maxlength')).toBe('100');
  });

  it('shows an empty database invitation', async () => {
    base(() => database({ gameCount: 0 }), []);
    renderPage(<DatabasePage />, ROUTE);
    expect(await screen.findByText('No games yet')).toBeTruthy();
    expect(screen.getByText('Import a PGN file above to fill this database.')).toBeTruthy();
  });
});

describe('GameActions', () => {
  it('disarms a delete that is not confirmed within a few seconds', () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    render(<GameActions game={dbGame(9)} canDelete onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete White 9 vs Black 9' }));
    expect(screen.getByRole('button', { name: 'Confirm: delete White 9 vs Black 9' })).toBeTruthy();
    act(() => void vi.advanceTimersByTime(5100));
    expect(screen.queryByRole('button', { name: 'Confirm: delete White 9 vs Black 9' })).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('offers only the Studio link on read-only databases', () => {
    render(<GameActions game={dbGame(9)} canDelete={false} onDelete={() => undefined} />);
    expect(screen.getByRole('link', { name: 'Analyse White 9 vs Black 9' }).getAttribute('href')).toBe('/studio?game=9');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('importOutcome', () => {
  const tracked = (last: JobInfo) => ({ jobId: last.id, before: 10, last });
  it('prefers the job counters, else the change in game count', () => {
    const last = job({ status: 'running', progress: { done: 5, total: null, message: null, counts: { imported: 4, duplicates: 1 } } });
    expect(importOutcome(tracked(last), null, database({ gameCount: 14 }))).toMatchObject({ status: 'done', added: 4, totalNow: 14 });
    const bare = job({ status: 'running' });
    expect(importOutcome(tracked(bare), null, database({ gameCount: 13 })).added).toBe(3);
    expect(importOutcome(tracked(bare), job({ status: 'error', error: 'boom' }), database({ gameCount: 10 }))).toMatchObject({
      status: 'error',
      error: 'boom',
      added: 0,
    });
  });

  it('trusts the final counters, else the larger of a lagging snapshot and the game count change', () => {
    const lagging = job({ id: 7, status: 'running', progress: { done: 3, total: null, message: null, counts: { imported: 2 } } });
    // gone, no lastImport: the snapshot says 2, the database grew by 6
    expect(importOutcome(tracked(lagging), null, database({ gameCount: 16 }))).toMatchObject({ status: 'done', added: 6, counts: { imported: 6 } });
    // gone, lastImport is this job: its counters win
    const final = job({ id: 7, status: 'done', progress: { done: 9, total: null, message: null, counts: { imported: 5, duplicates: 4 } } });
    expect(importOutcome(tracked(lagging), null, database({ gameCount: 16, lastImport: final }))).toMatchObject({ added: 5, counts: { duplicates: 4 } });
    // lastImport of another (older) job is ignored
    expect(importOutcome(tracked(lagging), null, database({ gameCount: 13, lastImport: { ...final, id: 3 } })).added).toBe(3);
  });

  it('labels the counters', () => {
    expect(importCountItems({ imported: 3, duplicates: 2, skipped: 1, 'skip:illegalMove': 1 }).map(i => i.label)).toEqual([
      'duplicates skipped',
      'skipped (1 illegal move)',
    ]);
    expect(importSummaryText({ imported: 1200, duplicates: 0, skipped: 0 })).toBe('1,200 imported');
  });
});
