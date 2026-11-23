/**
 * Settings and Admin have a page heading (h1) above their sections' h2s (web review).
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdminLayout from '../src/app/pages/admin/AdminLayout.tsx';
import SettingsPage from '../src/app/pages/SettingsPage.tsx';
import { ADMIN, renderAt, session, user, withFakeApi } from './web-account-helpers.tsx';

const api = withFakeApi();

describe('page headings', () => {
  it('Settings has a page heading above its sections', async () => {
    api().on('GET', '/api/session', session(user())).on('GET', '/api/me/sessions', { sessions: [] });
    renderAt(<SettingsPage />, { path: '/settings' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy();
  });

  it('Admin has one too', async () => {
    api().on('GET', '/api/session', session(ADMIN));
    renderAt(<AdminLayout />, { path: '/admin' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin' })).toBeTruthy();
  });
});
