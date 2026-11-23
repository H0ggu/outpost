import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, type SessionUser, type UserPrefs } from '@outpost/shared/api';
import SettingsPage from '../src/app/pages/SettingsPage.tsx';
import { apiError, later, renderAt, session, sessionRow, user, withFakeApi } from './web-account-helpers.tsx';

const api = withFakeApi();

/** Records sounds instead of playing them. */
const played: string[] = [];
beforeEach(() => {
  played.length = 0;
  vi.stubGlobal(
    'Audio',
    class {
      volume = 1;
      src: string;
      constructor(src: string) {
        this.src = src;
        played.push(src);
      }
      play() {
        return Promise.resolve();
      }
    },
  );
});

/** A server keeping the user's prefs, like PUT /api/me/prefs does. */
function prefsServer(start: SessionUser = user()) {
  const me = structuredClone(start);
  api()
    .on('GET', '/api/session', () => session(me))
    .on('GET', '/api/jobs/mine', { jobs: [] })
    .on('PUT', '/api/me/prefs', req => {
      me.prefs = { ...me.prefs, ...(req.body as Partial<UserPrefs>) };
      return me.prefs;
    });
  return me;
}

describe('SettingsPage', () => {
  it('asks visitors to sign in', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<SettingsPage />, { path: '/settings' });
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/login?next=%2Fsettings');
  });

  it('has a section menu kept in the URL', async () => {
    prefsServer();
    const { location } = renderAt(<SettingsPage />, { path: '/settings' });
    const menu = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(menu).getByRole('link', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(menu).getByRole('link', { name: 'Password' }));
    await waitFor(() => expect(location()).toBe('/settings?section=password'));
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeTruthy();
    expect(document.title).toBe('Password · Settings · Outpost');
  });

  it('applies a new theme at once and saves it', async () => {
    const me = prefsServer();
    renderAt(<SettingsPage />, { path: '/settings', layout: true });
    let release: (() => void) | undefined;
    api().on('PUT', '/api/me/prefs', async req => {
      await new Promise<void>(r => (release = r));
      me.prefs = { ...me.prefs, ...(req.body as Partial<UserPrefs>) };
      return me.prefs;
    });
    const light = await screen.findByRole('radio', { name: /^Light/ });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('black'));
    fireEvent.click(light);
    // Optimistic: the page switches before the server answers.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(screen.getByText('Saving…')).toBeTruthy();
    await act(async () => release?.());
    await waitFor(() => expect(api().find('PUT', '/api/me/prefs')).toHaveLength(1));
    expect(api().find('PUT', '/api/me/prefs')[0]?.body).toEqual({ theme: 'light' });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(me.prefs.theme).toBe('light');
    expect(localStorage.getItem('outpost.theme')).toBe('light');
  });

  it('rolls back a preference the server refused', async () => {
    prefsServer();
    api().on('PUT', '/api/me/prefs', apiError(400, 'validation', 'boardTheme: invalid'));
    renderAt(<SettingsPage />, { path: '/settings', layout: true });
    fireEvent.click(await screen.findByRole('radio', { name: 'Maple' }));
    expect(await screen.findByText(/Could not save/)).toBeTruthy();
    await waitFor(() => expect(document.body.dataset.board).toBe('brown'));
  });

  it('picks boards, pieces and sounds (with a preview)', async () => {
    const me = prefsServer();
    renderAt(<SettingsPage />, { path: '/settings', layout: true });
    fireEvent.click(await screen.findByRole('radio', { name: 'Green' }));
    await waitFor(() => expect(me.prefs.boardTheme).toBe('green'));
    fireEvent.click(screen.getByRole('radio', { name: 'Merida' }));
    await waitFor(() => expect(me.prefs.pieceSet).toBe('merida'));
    await waitFor(() => expect(document.body.style.getPropertyValue('---white-knight')).toContain('/lichess/piece/merida/wN.svg'));
    fireEvent.click(screen.getByRole('radio', { name: 'Piano' }));
    await waitFor(() => expect(me.prefs.soundSet).toBe('piano'));
    expect(played).toContain('/lichess/sound/piano/Move.mp3');
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    expect(played.at(-1)).toBe('/lichess/sound/piano/Capture.mp3');
    // A live board preview and lila's thumbnails.
    expect(screen.getByText('Green board, Merida pieces')).toBeTruthy();
    expect(document.querySelector('.acc-preview-board .cg-wrap')).not.toBeNull();
    expect(document.querySelector('img[src="/lichess/board/maple.thumbnail.jpg"]')).not.toBeNull();
  });

  it('keeps the newest choice when saves overlap', async () => {
    const me = prefsServer();
    let release: (() => void) | undefined;
    // The server applies both in order, but the first answer (blue) arrives last.
    api().on('PUT', '/api/me/prefs', async req => {
      const patch = req.body as Partial<UserPrefs>;
      me.prefs = { ...me.prefs, ...patch };
      const answer = { ...me.prefs };
      if (patch.boardTheme === 'blue') await new Promise<void>(r => (release = r));
      return answer;
    });
    renderAt(<SettingsPage />, { path: '/settings', layout: true });
    fireEvent.click(await screen.findByRole('radio', { name: 'Blue' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Olive' }));
    await waitFor(() => expect(api().find('PUT', '/api/me/prefs')).toHaveLength(2));
    await waitFor(() => expect(document.body.dataset.board).toBe('olive'));
    expect(me.prefs.boardTheme).toBe('olive');
    await act(async () => release?.());
    await new Promise(r => setTimeout(r, 20));
    expect(document.body.dataset.board).toBe('olive');
  });

  it('saves display preferences', async () => {
    const me = prefsServer();
    renderAt(<SettingsPage />, { path: '/settings?section=display' });
    fireEvent.click(await screen.findByRole('radio', { name: 'White / Black results' }));
    await waitFor(() => expect(me.prefs.winratePerspective).toBe('white'));
    fireEvent.click(screen.getByRole('radio', { name: 'UTC' }));
    await waitFor(() => expect(me.prefs.timezone).toBe('utc'));
    expect(await screen.findByText(/\d\d:\d\d UTC$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Focus' }));
    await waitFor(() => expect(me.prefs.studioLayout).toBe('focus'));
    expect(api().find('PUT', '/api/me/prefs').map(c => c.body)).toEqual([
      { winratePerspective: 'white' },
      { timezone: 'utc' },
      { studioLayout: 'focus' },
    ]);
  });
});

describe('Change password', () => {
  const fill = (current: string, next: string, confirm = next) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  };

  it('checks the new password, shows a wrong current one at its field, then changes it', async () => {
    prefsServer();
    api().on('POST', '/api/me/password', apiError(403, 'forbidden', 'Current password is wrong'));
    renderAt(<SettingsPage />, { path: '/settings?section=password' });
    await screen.findByLabelText('Current password');
    fill('old-password', 'short', 'other');
    expect(await screen.findByText('Use at least 8 characters.')).toBeTruthy();
    expect(screen.getByText('The passwords do not match.')).toBeTruthy();
    fill('old-password', 'old-password');
    expect(await screen.findByText('Choose a password different from the current one.')).toBeTruthy();
    expect(api().find('POST', '/api/me/password')).toHaveLength(0);

    fill('bad-password', 'new-password-1');
    expect(await screen.findByText('Current password is wrong')).toBeTruthy();
    expect(screen.getByLabelText('Current password').getAttribute('aria-invalid')).toBe('true');

    api().on('POST', '/api/me/password', { ok: true });
    fill('old-password', 'new-password-1');
    expect(await screen.findByText(/Password changed/)).toBeTruthy();
    expect(api().find('POST', '/api/me/password').at(-1)?.body).toEqual({ currentPassword: 'old-password', newPassword: 'new-password-1' });
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
  });

  it('reveals a password on request', async () => {
    prefsServer();
    renderAt(<SettingsPage />, { path: '/settings?section=password' });
    const input = (await screen.findByLabelText('Current password')) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0]!);
    expect(input.type).toBe('text');
  });
});

describe('Two-factor authentication', () => {
  const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Outpost:alice?secret=JBSWY3DPEHPK3PXP', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' };

  /** Like prefsServer, but session refetches are slow, as over a network. */
  const slowSessionServer = (start: SessionUser) => {
    const me = prefsServer(start);
    api().on('GET', '/api/session', () => later(50, session(me)));
    return me;
  };

  it('asks for the password, then turns it on with the QR code and a confirmation code', async () => {
    const me = slowSessionServer(user());
    api()
      .on('POST', '/api/me/totp/setup', req =>
        (req.body as { password?: string }).password === 'right-password' ? SETUP : apiError(403, 'forbidden', 'Current password is incorrect'),
      )
      .on('POST', '/api/me/totp/enable', req => {
        if ((req.body as { code: string }).code !== '123456') return apiError(403, 'forbidden', 'That code is not valid');
        me.totpEnabled = true;
        return { ok: true };
      });
    renderAt(<SettingsPage />, { path: '/settings?section=two-factor' });
    const start = await screen.findByRole('button', { name: 'Set up two-factor authentication' });
    fireEvent.click(start);
    expect(await screen.findByText('Enter your password.')).toBeTruthy();
    expect(api().find('POST', '/api/me/totp/setup')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-password' } });
    fireEvent.click(start);
    expect(await screen.findByText('Current password is incorrect')).toBeTruthy();
    expect(screen.getByLabelText('Current password').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'right-password' } });
    fireEvent.click(start);

    const qr = (await screen.findByRole('img', { name: /QR code/ })) as HTMLImageElement;
    expect(api().find('POST', '/api/me/totp/setup').at(-1)?.body).toEqual({ password: 'right-password' });
    expect(qr.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(qr.src)).toContain('<rect/>');
    expect(screen.getByLabelText('Secret key').textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect(screen.getByRole('link', { name: /Open in an authenticator app/ }).getAttribute('href')).toBe(SETUP.otpauthUrl);

    const code = screen.getByLabelText('Authentication code');
    fireEvent.change(code, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Enter the 6-digit code shown by the app.')).toBeTruthy();
    fireEvent.change(code, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(/That code was not accepted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    // The form is replaced as soon as the cached session flips; the confirmation still shows.
    expect(await screen.findByText(/Two-factor authentication is on/)).toBeTruthy();
    expect(api().find('POST', '/api/me/totp/enable').at(-1)?.body).toEqual({ code: '123456' });
    expect(await screen.findByRole('button', { name: 'Turn off two-factor authentication' })).toBeTruthy();
  });

  it('uses the PNG QR code and shows the expiry when the server sends them', async () => {
    prefsServer();
    api().on('POST', '/api/me/totp/setup', { ...SETUP, qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 10 * 60_000 });
    renderAt(<SettingsPage />, { path: '/settings?section=two-factor' });
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up two-factor authentication' }));
    const qr = (await screen.findByRole('img', { name: /QR code/ })) as HTMLImageElement;
    expect(qr.src).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByText('Confirm in 10 minutes, or start again.')).toBeTruthy();
  });

  it('turns it off with the password alone or a code alone', async () => {
    const me = slowSessionServer(user({ totpEnabled: true }));
    api().on('POST', '/api/me/totp/disable', req => {
      const b = req.body as { password: string; code: string };
      if (b.password !== 'right-password' && b.code !== '222222') return apiError(403, 'forbidden', 'Wrong password or code');
      me.totpEnabled = false;
      return { ok: true };
    });
    renderAt(<SettingsPage />, { path: '/settings?section=two-factor' });
    const button = await screen.findByRole('button', { name: 'Turn off two-factor authentication' });
    fireEvent.click(button);
    expect(await screen.findByText('Enter your password or a current code.')).toBeTruthy();
    expect(api().find('POST', '/api/me/totp/disable')).toHaveLength(0);

    // A code alone (lost password managers happen too): a refusal shows at the code.
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '111111' } });
    fireEvent.click(button);
    expect(await screen.findByText('Wrong password or code')).toBeTruthy();
    expect(screen.getByLabelText('Authentication code').getAttribute('aria-invalid')).toBe('true');
    expect(api().find('POST', '/api/me/totp/disable').at(-1)?.body).toEqual({ password: '', code: '111111' });

    // The password alone (a lost authenticator).
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right-password' } });
    fireEvent.click(button);
    expect(await screen.findByText('Two-factor authentication is off.')).toBeTruthy();
    expect(api().find('POST', '/api/me/totp/disable').at(-1)?.body).toEqual({ password: 'right-password', code: '' });
    expect(await screen.findByRole('button', { name: 'Set up two-factor authentication' })).toBeTruthy();
  });

  it('checks the code format and places a refusal of both proofs above the button', async () => {
    prefsServer(user({ totpEnabled: true }));
    api().on('POST', '/api/me/totp/disable', apiError(403, 'forbidden', 'Wrong password or code'));
    renderAt(<SettingsPage />, { path: '/settings?section=two-factor' });
    const button = await screen.findByRole('button', { name: 'Turn off two-factor authentication' });
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '12' } });
    fireEvent.click(button);
    expect(await screen.findByText('Enter the current 6-digit code.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(button);
    expect(await screen.findByText('Wrong password or code')).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByLabelText('Authentication code').getAttribute('aria-invalid')).toBeNull();
  });

  it('reports a failed setup', async () => {
    prefsServer();
    api().on('POST', '/api/me/totp/setup', apiError(500, 'internal', 'Internal server error'));
    renderAt(<SettingsPage />, { path: '/settings?section=two-factor' });
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up two-factor authentication' }));
    expect(await screen.findByText('Could not start the setup')).toBeTruthy();
  });
});

describe('Sessions', () => {
  const rows = [
    sessionRow({ id: 'cur', current: true, userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X 10_15_7) Chrome/140.0 Safari/537.36' }),
    sessionRow({ id: 'phone', ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Version/19.0 Mobile Safari/604.1' }),
    sessionRow({ id: 'old', ip: null, lastSeenAt: Date.now() - 5 * 86_400_000 }),
  ];

  it('lists sessions and revokes another one', async () => {
    prefsServer();
    let list = [...rows];
    api()
      .on('GET', '/api/me/sessions', () => ({ sessions: list }))
      .on('DELETE', /^\/api\/me\/sessions\//, req => {
        list = list.filter(s => s.id !== req.path.split('/').pop());
        return { ok: true };
      });
    renderAt(<SettingsPage />, { path: '/settings?section=sessions' });
    expect(await screen.findByText('Chrome on macOS')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText('Safari on iPhone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Safari on iPhone (198.51.100.7)' }));
    await waitFor(() => expect(screen.queryByText('Safari on iPhone')).toBeNull());
    expect(api().find('DELETE', '/api/me/sessions/phone')).toHaveLength(1);
    expect(screen.getByText('Signed out Safari on iPhone.')).toBeTruthy();
  });

  it('signs out every other session after confirming', async () => {
    prefsServer();
    let list = [...rows];
    api()
      .on('GET', '/api/me/sessions', () => ({ sessions: list }))
      .on('DELETE', /^\/api\/me\/sessions\//, req => {
        list = list.filter(s => s.id !== req.path.split('/').pop());
        return { ok: true };
      });
    renderAt(<SettingsPage />, { path: '/settings?section=sessions' });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out other sessions' }));
    const dialog = screen.getByRole('dialog', { name: 'Sign out other sessions?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out 2 sessions' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api().find('DELETE', /^\/api\/me\/sessions\//).map(c => c.path)).toEqual(['/api/me/sessions/phone', '/api/me/sessions/old']);
    expect(await screen.findByText('Signed out every other session.')).toBeTruthy();
  });

  it('signs this device out and goes to the login page', async () => {
    let signedIn = true;
    api()
      .on('GET', '/api/session', () => session(signedIn ? user() : null))
      .on('GET', '/api/me/sessions', { sessions: rows })
      .on('DELETE', '/api/me/sessions/cur', () => {
        signedIn = false;
        return { ok: true };
      });
    const { location } = renderAt(<SettingsPage />, { path: '/settings?section=sessions' });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out this device' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(location()).toBe('/login?next=%2Fsettings'));
  });

  it('shows a load error with retry', async () => {
    prefsServer();
    api().on('GET', '/api/me/sessions', apiError(500, 'internal', 'db locked'));
    renderAt(<SettingsPage />, { path: '/settings?section=sessions' });
    expect(await screen.findByText('db locked')).toBeTruthy();
    api().on('GET', '/api/me/sessions', { sessions: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No sessions')).toBeTruthy();
  });
});

describe('defaults', () => {
  it('match the contract (true black first)', () => {
    expect(DEFAULT_PREFS.theme).toBe('black');
  });
});
