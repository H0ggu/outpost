import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../src/app/api/hooks.ts';
import LoginPage from '../src/app/pages/LoginPage.tsx';
import SetupPage from '../src/app/pages/SetupPage.tsx';
import SignupPage from '../src/app/pages/SignupPage.tsx';
import { ADMIN, apiError, renderAt, session, user, withFakeApi } from './web-account-helpers.tsx';

const api = withFakeApi();

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }));

describe('LoginPage', () => {
  it('signs in and goes to ?next=', async () => {
    let signedIn = false;
    api()
      .on('GET', '/api/session', () => session(signedIn ? user() : null))
      .on('POST', '/api/login', () => {
        signedIn = true;
        return { user: user() };
      });
    const { location, qc } = renderAt(<LoginPage />, { path: '/login?next=%2Fu%2Fmagnus%2Fgames' });
    await screen.findByLabelText('Username');
    type('Username', '  alice ');
    type('Password', 'secret-pass');
    submit(/^sign in$/i);
    await waitFor(() => expect(location()).toBe('/u/magnus/games'));
    expect(api().find('POST', '/api/login')[0]?.body).toEqual({ username: 'alice', password: 'secret-pass' });
    expect(api().find('POST', '/api/login')[0]?.headers.get('x-outpost')).toBe('1');
    await waitFor(() => expect(qc.getQueryData<{ user: unknown }>(queryKeys.session)?.user).toMatchObject({ username: 'alice' }));
  });

  it('asks for the TOTP code after totp_required, then sends it with the password', async () => {
    api()
      .on('GET', '/api/session', session(null))
      .on('POST', '/api/login', req =>
        (req.body as { totp?: string }).totp === '123456'
          ? { user: user() }
          : apiError(401, 'totp_required', 'A two-factor code is required'),
      );
    const { location } = renderAt(<LoginPage />, { path: '/login' });
    type(await screen.findByLabelText('Username').then(() => 'Username'), 'alice');
    type('Password', 'secret-pass');
    submit(/^sign in$/i);
    const code = await screen.findByLabelText('Authentication code');
    expect(screen.getByText(/Two-factor authentication is on for/)).toBeTruthy();
    // totp_required is the cue for this step, not an error.
    expect(screen.queryByRole('alert')).toBeNull();

    // Client-side check first.
    fireEvent.change(code, { target: { value: '12' } });
    submit(/verify and sign in/i);
    expect(await screen.findByText(/Enter the 6-digit code/)).toBeTruthy();
    expect(api().find('POST', '/api/login')).toHaveLength(1);

    // A rejected code stays on this step.
    fireEvent.change(code, { target: { value: '654321' } });
    submit(/verify and sign in/i);
    expect(await screen.findByText(/That code was not accepted/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123 456' } });
    submit(/verify and sign in/i);
    await waitFor(() => expect(location()).toBe('/'));
    expect(api().find('POST', '/api/login').at(-1)?.body).toEqual({ username: 'alice', password: 'secret-pass', totp: '123456' });
  });

  it('goes back from the code step to the password step', async () => {
    api()
      .on('GET', '/api/session', session(null))
      .on('POST', '/api/login', apiError(401, 'totp_required', 'code needed'));
    renderAt(<LoginPage />, { path: '/login' });
    await screen.findByLabelText('Username');
    type('Username', 'alice');
    type('Password', 'pw-pw-pw-pw');
    submit(/^sign in$/i);
    await screen.findByLabelText('Authentication code');
    submit('Back');
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('alice');
  });

  it('says wrong username or password, and explains throttling', async () => {
    api()
      .on('GET', '/api/session', session(null))
      .on('POST', '/api/login', apiError(401, 'unauthorized', 'Invalid credentials'));
    renderAt(<LoginPage />, { path: '/login' });
    await screen.findByLabelText('Username');
    submit(/^sign in$/i);
    expect(await screen.findByText('Enter your username.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(api().find('POST', '/api/login')).toHaveLength(0);
    type('Username', 'alice');
    type('Password', 'nope-nope');
    submit(/^sign in$/i);
    expect(await screen.findByText('Wrong username or password.')).toBeTruthy();
    api().on('POST', '/api/login', apiError(429, 'rate_limited', 'Too many requests'));
    submit(/^sign in$/i);
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
  });

  it('marks invalid fields from validation issues', async () => {
    api()
      .on('GET', '/api/session', session(null))
      .on('POST', '/api/login', apiError(400, 'validation', 'username: too long', { issues: [{ path: 'username', message: 'too long' }] }));
    renderAt(<LoginPage />, { path: '/login' });
    await screen.findByLabelText('Username');
    type('Username', 'x');
    type('Password', 'pw');
    submit(/^sign in$/i);
    expect(await screen.findByText('too long')).toBeTruthy();
    expect(screen.getByLabelText('Username').getAttribute('aria-invalid')).toBe('true');
  });

  it('redirects a signed-in user and ignores unsafe next targets', async () => {
    api().on('GET', '/api/session', session(user()));
    const { location } = renderAt(<LoginPage />, { path: '/login?next=https%3A%2F%2Fevil.example' });
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('points to setup and hides sign-up when closed', async () => {
    api().on('GET', '/api/session', session(null, { setupRequired: true, signupMode: 'closed' }));
    renderAt(<LoginPage />, { path: '/login' });
    expect((await screen.findByRole('link', { name: 'Create the first admin account' })).getAttribute('href')).toBe('/setup');
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull();
  });

  it('shows a retryable error when the server is down', async () => {
    api().on('GET', '/api/session', apiError(503, 'upstream_unavailable', 'down'));
    renderAt(<LoginPage />, { path: '/login' });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('SignupPage', () => {
  it('explains closed sign-ups', async () => {
    api().on('GET', '/api/session', session(null, { signupMode: 'closed' }));
    renderAt(<SignupPage />, { path: '/signup' });
    expect(await screen.findByText('Sign-ups are closed')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('sends people to setup before the first admin exists', async () => {
    api().on('GET', '/api/session', session(null, { setupRequired: true, signupMode: 'open' }));
    renderAt(<SignupPage />, { path: '/signup' });
    expect((await screen.findByRole('link', { name: /Set up Outpost/ })).getAttribute('href')).toBe('/setup');
  });

  it('prefills the invite code and signs the new user in', async () => {
    api()
      .on('GET', '/api/session', session(null, { signupMode: 'invite' }))
      .on('POST', '/api/signup', { user: user({ username: 'newbie' }) });
    const { location } = renderAt(<SignupPage />, { path: '/signup?invite=INV-42' });
    expect(((await screen.findByLabelText('Invite code')) as HTMLInputElement).value).toBe('INV-42');
    type('Username', 'newbie');
    type('Password', 'long-password');
    type('Confirm password', 'long-password');
    submit(/create account/i);
    await waitFor(() => expect(location()).toBe('/'));
    expect(api().find('POST', '/api/signup')[0]?.body).toEqual({ username: 'newbie', password: 'long-password', invite: 'INV-42' });
  });

  it('checks the form before sending', async () => {
    api().on('GET', '/api/session', session(null, { signupMode: 'invite' }));
    renderAt(<SignupPage />, { path: '/signup' });
    await screen.findByLabelText('Invite code');
    type('Username', 'n');
    type('Password', 'short');
    type('Confirm password', 'other');
    submit(/create account/i);
    expect(await screen.findByText('Enter the invite code you were given.')).toBeTruthy();
    expect(screen.getByText('Use at least 2 characters.')).toBeTruthy();
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
    expect(screen.getByText('The passwords do not match.')).toBeTruthy();
    expect(api().find('POST', '/api/signup')).toHaveLength(0);
  });

  it('puts a taken name and a refused invite next to their fields', async () => {
    api()
      .on('GET', '/api/session', session(null, { signupMode: 'invite' }))
      .on('POST', '/api/signup', apiError(409, 'conflict', 'That username is taken'));
    renderAt(<SignupPage />, { path: '/signup?invite=X' });
    await screen.findByLabelText('Invite code');
    type('Username', 'alice');
    type('Password', 'long-password');
    type('Confirm password', 'long-password');
    submit(/create account/i);
    expect(await screen.findByText('That username is taken')).toBeTruthy();
    expect(screen.getByLabelText('Username').getAttribute('aria-invalid')).toBe('true');

    api().on('POST', '/api/signup', apiError(403, 'forbidden', 'Invite code is invalid or used'));
    submit(/create account/i);
    expect(await screen.findByText('Invite code is invalid or used')).toBeTruthy();
    expect(screen.getByLabelText('Invite code').getAttribute('aria-invalid')).toBe('true');
  });

  it('needs no invite code when sign-up is open', async () => {
    api()
      .on('GET', '/api/session', session(null, { signupMode: 'open' }))
      .on('POST', '/api/signup', { user: user() });
    renderAt(<SignupPage />, { path: '/signup?invite=ignored' });
    await screen.findByLabelText('Username');
    expect(screen.queryByLabelText('Invite code')).toBeNull();
    type('Username', 'alice');
    type('Password', 'long-password');
    type('Confirm password', 'long-password');
    submit(/create account/i);
    await waitFor(() => expect(api().find('POST', '/api/signup')).toHaveLength(1));
    expect(api().find('POST', '/api/signup')[0]?.body).toEqual({ username: 'alice', password: 'long-password' });
  });
});

describe('SetupPage', () => {
  it('creates the first admin and opens the instance settings', async () => {
    let done = false;
    api()
      .on('GET', '/api/session', () => (done ? session(ADMIN) : session(null, { setupRequired: true })))
      .on('POST', '/api/setup', () => {
        done = true;
        return { user: ADMIN };
      });
    const { location, qc } = renderAt(<SetupPage />, { path: '/setup' });
    type(await screen.findByLabelText('Setup token').then(() => 'Setup token'), ' tok-123 ');
    type('Admin username', 'root');
    type('Password', 'long-password');
    type('Confirm password', 'long-password');
    submit(/create admin account/i);
    await waitFor(() => expect(location()).toBe('/admin/settings'));
    expect(api().find('POST', '/api/setup')[0]?.body).toEqual({ token: 'tok-123', username: 'root', password: 'long-password' });
    await waitFor(() => expect(qc.getQueryData<{ setupRequired: boolean }>(queryKeys.session)?.setupRequired).toBe(false));
    expect(api().find('GET', '/api/session').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a refused token at the token field', async () => {
    api()
      .on('GET', '/api/session', session(null, { setupRequired: true }))
      .on('POST', '/api/setup', apiError(403, 'forbidden', 'Invalid setup token'));
    renderAt(<SetupPage />, { path: '/setup' });
    await screen.findByLabelText('Setup token');
    type('Setup token', 'wrong');
    type('Admin username', 'root');
    type('Password', 'long-password');
    type('Confirm password', 'long-password');
    submit(/create admin account/i);
    expect(await screen.findByText('Invalid setup token')).toBeTruthy();
    expect(screen.getByLabelText('Setup token').getAttribute('aria-invalid')).toBe('true');
  });

  it('requires every field', async () => {
    api().on('GET', '/api/session', session(null, { setupRequired: true }));
    renderAt(<SetupPage />, { path: '/setup' });
    await screen.findByLabelText('Setup token');
    submit(/create admin account/i);
    expect(await screen.findByText('Paste the setup token from the server log.')).toBeTruthy();
    expect(screen.getByText('Choose a username.')).toBeTruthy();
    expect(api().find('POST', '/api/setup')).toHaveLength(0);
  });

  it('says when the instance is already set up', async () => {
    api().on('GET', '/api/session', session(null));
    renderAt(<SetupPage />, { path: '/setup' });
    expect(await screen.findByText('This Outpost is already set up')).toBeTruthy();
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login');
  });
});
