/**
 * The keyboard of the menus that say `role="menu"` (web review): the account menu and the admin
 * row menus take focus when they open, move with the arrows and give focus back on Escape.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from '../src/app/pages/components/account/misc.tsx';
import { ADMIN, renderAt, session, user, withFakeApi } from './web-account-helpers.tsx';

const api = withFakeApi();

describe('the account menu keyboard', () => {
  const Page = () => <h1>Content</h1>;
  const active = () => document.activeElement as HTMLElement;

  it('moves focus into the menu, around it with the arrows, and back to its button on Escape', async () => {
    api().on('GET', '/api/session', session(ADMIN)).on('GET', '/api/jobs/mine', { jobs: [] });
    renderAt(<Page />, { layout: true, path: '/players' });
    const button = await screen.findByRole('button', { name: 'Account menu (root)' });
    button.focus();
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(active().textContent).toBe('Bookmarks'));
    fireEvent.keyDown(active(), { key: 'ArrowDown' });
    expect(active().textContent).toBe('New profile');
    fireEvent.keyDown(active(), { key: 'End' });
    expect(active().textContent).toBe('Sign out');
    fireEvent.keyDown(active(), { key: 'ArrowDown' });
    expect(active().textContent).toBe('Bookmarks');
    fireEvent.keyDown(active(), { key: 'ArrowUp' });
    expect(active().textContent).toBe('Sign out');
    fireEvent.keyDown(active(), { key: 'Home' });
    expect(active().textContent).toBe('Bookmarks');
    // Items are reached with the arrows, not Tab.
    for (const item of within(menu).getAllByRole('menuitem')) expect(item.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(active(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(active()).toBe(button);
  });

  it('opens at the last item with ArrowUp, and Tab leaves it from the button', async () => {
    api().on('GET', '/api/session', session(user())).on('GET', '/api/jobs/mine', { jobs: [] });
    renderAt(<Page />, { layout: true, path: '/players' });
    const button = await screen.findByRole('button', { name: 'Account menu (alice)' });
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowUp' });
    await waitFor(() => expect(active().textContent).toBe('Sign out'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
    fireEvent.keyDown(active(), { key: 'Tab' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(active()).toBe(button);
  });
});

describe('row menus', () => {
  it('take focus when they open and give it back on Escape', async () => {
    const onSelect = vi.fn();
    render(
      <RowMenu
        label="Actions for alice"
        actions={[
          { label: 'Make admin', onSelect },
          { label: 'Disable account', onSelect, disabled: true },
          { label: 'Delete account', onSelect },
        ]}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Actions for alice' });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Make admin'));
    // The disabled action is skipped.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Delete account');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(toggle);
  });
});
