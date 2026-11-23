import { useMutation } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api as client } from '../src/app/api/client.ts';
import NotFoundPage from '../src/app/pages/NotFoundPage.tsx';
import { ADMIN, apiError, job, renderAt, session, user, withFakeApi } from './web-account-helpers.tsx';

const api = withFakeApi();

const Page = () => <h1>Content</h1>;

/** A page with a mutation, to see the job indicator look again after one. */
function UpdateButton() {
  const m = useMutation({ mutationFn: () => client.post('/api/profiles/x/update') });
  return (
    <button type="button" onClick={() => m.mutate()}>
      Update profile
    </button>
  );
}

describe('Layout', () => {
  it('has the main navigation, with the Studio as a full page link', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<Page />, { layout: true, path: '/' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map(a => [a.textContent, a.getAttribute('href')]);
    expect(hrefs).toEqual([
      ['Home', '/'],
      ['Players', '/players'],
      ['Databases', '/databases'],
      ['Prep', '/prep'],
      ['Broadcasts', '/broadcasts'],
      ['Explorer', '/explorer'],
      ['Studio', '/studio'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign up' }).getAttribute('href')).toBe('/signup');
  });

  it('searches players from the header', async () => {
    api().on('GET', '/api/session', session(null));
    const { location } = renderAt(<Page />, { layout: true, path: '/players' });
    const [box] = screen.getAllByRole('searchbox', { name: 'Search players' });
    fireEvent.change(box!, { target: { value: '  Magnus Carlsen ' } });
    fireEvent.submit(box!.closest('form')!);
    await waitFor(() => expect(location()).toBe('/search?q=Magnus+Carlsen'));
    expect((screen.getAllByRole('searchbox')[0] as HTMLInputElement).value).toBe('Magnus Carlsen');
  });

  it('opens and closes the phone menu', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<Page />, { layout: true });
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('navigation', { name: 'Main' }).className).toContain('open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('navigation', { name: 'Main' }).className).not.toContain('open');
  });

  it('uses true black by default and the signed-in user theme otherwise', async () => {
    api().on('GET', '/api/session', session(null));
    const first = renderAt(<Page />, { layout: true });
    await screen.findByRole('link', { name: 'Sign in' });
    expect(document.documentElement.dataset.theme).toBe('black');
    first.unmount();

    api()
      .on('GET', '/api/session', session(user({ prefs: { ...user().prefs, theme: 'light', boardTheme: 'blue' } })))
      .on('GET', '/api/jobs/mine', { jobs: [] });
    renderAt(<Page />, { layout: true });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(document.body.dataset.board).toBe('blue');
  });

  it('has a user menu with settings, admin (for admins) and sign out', async () => {
    let signedIn = true;
    api()
      .on('GET', '/api/session', () => session(signedIn ? ADMIN : null))
      .on('GET', '/api/jobs/mine', { jobs: [] })
      .on('POST', '/api/logout', () => {
        signedIn = false;
        return { ok: true };
      });
    const { location } = renderAt(<Page />, { layout: true, path: '/players' });
    fireEvent.click(await screen.findByRole('button', { name: 'Account menu (root)' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    expect(within(menu).getByRole('menuitem', { name: 'Admin' }).getAttribute('href')).toBe('/admin');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(api().find('POST', '/api/logout')).toHaveLength(1));
    await waitFor(() => expect(location()).toBe('/'));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it('hides the admin entry from regular users', async () => {
    api()
      .on('GET', '/api/session', session(user()))
      .on('GET', '/api/jobs/mine', { jobs: [] });
    renderAt(<Page />, { layout: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Account menu (alice)' }));
    expect(screen.queryByRole('menuitem', { name: 'Admin' })).toBeNull();
  });

  it('shows my running jobs with progress, and nothing when idle', async () => {
    api()
      .on('GET', '/api/session', session(ADMIN))
      .on('GET', '/api/jobs/mine', {
        jobs: [job(), job({ id: 2, label: 'Sync chesscom:hikaru', status: 'queued', progress: null, queuePosition: 3, startedAt: null })],
      });
    renderAt(<Page />, { layout: true });
    const toggle = await screen.findByRole('button', { name: '2 jobs in progress (1 running)' });
    expect(toggle.getAttribute('data-count')).toBe('2');
    fireEvent.click(toggle);
    const panel = screen.getByRole('region', { name: 'Jobs in progress' });
    expect(within(panel).getByText('Sync lichess:drnykterstein')).toBeTruthy();
    expect(within(panel).getByText('Queued #3')).toBeTruthy();
    expect(within(panel).getAllByRole('progressbar')[0]?.getAttribute('aria-valuenow')).toBe('30');
    expect(within(panel).getByRole('link', { name: 'All jobs' }).getAttribute('href')).toBe('/admin/jobs');
  });

  it('looks for new jobs after any successful mutation', async () => {
    let jobs: ReturnType<typeof job>[] = [];
    api()
      .on('GET', '/api/session', session(user()))
      .on('GET', '/api/jobs/mine', () => ({ jobs }))
      .on('POST', '/api/profiles/x/update', () => {
        jobs = [job({ status: 'queued', queuePosition: 1, progress: null, startedAt: null })];
        return { ok: true };
      });
    renderAt(<UpdateButton />, { layout: true });
    await screen.findByRole('button', { name: 'Update profile' });
    await waitFor(() => expect(api().find('GET', '/api/jobs/mine')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /jobs? in progress/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update profile' }));
    expect(await screen.findByRole('button', { name: '1 job in progress' })).toBeTruthy();
  });

  it('does not ask for jobs when signed out, and survives a failing jobs endpoint', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<Page />, { layout: true });
    await screen.findByRole('link', { name: 'Sign in' });
    expect(api().find('GET', '/api/jobs/mine')).toHaveLength(0);
  });

  it('warns while setup is needed and when the server cannot be reached', async () => {
    api().on('GET', '/api/session', session(null, { setupRequired: true }));
    const first = renderAt(<Page />, { layout: true, path: '/players' });
    expect((await screen.findByRole('link', { name: 'Create the first admin account' })).getAttribute('href')).toBe('/setup');
    first.unmount();

    api().on('GET', '/api/session', apiError(502, 'upstream_error', 'bad gateway'));
    renderAt(<Page />, { layout: true });
    expect(await screen.findByText(/Cannot reach the Outpost server/)).toBeTruthy();
    api().on('GET', '/api/session', session(null));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Cannot reach the Outpost server/)).toBeNull());
  });

  it('has the AGPL notice and opens NOTICE.md from the footer', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<Page />, { layout: true });
    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByText(/0\.1\.0/)).toBeTruthy();
    expect(within(footer).getByRole('link', { name: 'GNU AGPL v3 or later' }).getAttribute('href')).toBe('https://www.gnu.org/licenses/agpl-3.0.html');
    expect(footer.textContent).toContain('Not affiliated with Lichess or Chess.com');
    await act(async () => {
      fireEvent.click(within(footer).getByRole('button', { name: 'Notices and attribution' }));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Notices and attribution' });
    // The real NOTICE.md, rendered: headings, the piece-set credits and the AGPL.
    expect(await within(dialog).findByRole('heading', { name: 'Lichess open-source projects' })).toBeTruthy();
    expect(dialog.textContent).toContain('GNU Affero General Public License');
    expect(dialog.textContent).toContain('cburnett');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('NotFoundPage', () => {
  it('names the missing path and offers search and links', async () => {
    api().on('GET', '/api/session', session(null));
    const { location } = renderAt(<NotFoundPage />, { layout: true, path: '/no/such/page' });
    expect(await screen.findByRole('heading', { name: /Page not found/ })).toBeTruthy();
    expect(screen.getByText('/no/such/page')).toBeTruthy();
    expect(document.title).toBe('Page not found · Outpost');
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    const search = within(main).getByRole('searchbox', { name: 'Search players' });
    fireEvent.change(search, { target: { value: 'hikaru' } });
    fireEvent.click(within(main).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(location()).toBe('/search?q=hikaru'));
  });
});
