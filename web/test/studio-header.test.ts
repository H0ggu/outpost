/**
 * The Studio's site header (src/studio/view/header.ts, lila's #top markup) and what keeps it in step
 * with the SPA's: the nav folds into the hamburger at the same width (scripts/lila-patches/006), and
 * the user's link can't wrap under its icon onto the Studio bar (review finding ui-1).
 */
import { DEFAULT_PREFS, type SessionInfo } from '@outpost/shared/api';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attributesModule, classModule, init } from 'snabbdom';
import { renderHeader, type HeaderCtrl } from '../src/studio/view/header.ts';

const patch = init([classModule, attributesModule]);

// Stylesheets as text (vitest's `css: false` empties `?raw` CSS imports, so read them from disk; not
// `new URL(…, import.meta.url)`, which Vite rewrites into an asset URL).
let studioCss = '';
let layoutCss = '';
let lilaVariables = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as {
    readFileSync: (path: string, encoding: 'utf8') => string;
  };
  const web = `${decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/\/[^/]*$/, ''))}/..`;
  studioCss = fs.readFileSync(`${web}/src/studio/studio.css`, 'utf8');
  layoutCss = fs.readFileSync(`${web}/src/app/Layout.css`, 'utf8');
  lilaVariables = fs.readFileSync(`${web}/vendor/lila/lib/css/abstract/_variables.scss`, 'utf8');
});

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  user: null,
  setupRequired: false,
  signupMode: 'invite',
  anonymousBrowsing: false,
  hasLichessToken: false,
  version: '0.1.0',
  sourceUrl: null,
  ...over,
});

function render(s: SessionInfo | null): HTMLElement {
  const ctrl: HeaderCtrl = { session: s, loginUrl: () => '/login?next=%2Fstudio' };
  const host = document.createElement('div');
  document.body.append(host);
  return patch(host, renderHeader(ctrl)).elm as HTMLElement;
}

/** The declarations of the first rule whose selector list is exactly `selector`, outside media queries too. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

describe('Studio header', () => {
  afterEach(() => document.body.replaceChildren());

  it('has the SPA’s search pill with its icon, kept out of the accessible name', () => {
    const top = render(session());
    const form = top.querySelector('form.studio-search')!;
    expect(form.getAttribute('action')).toBe('/search');
    const icon = form.querySelector('i[data-icon]')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(form.querySelector('input[name="q"]')!.getAttribute('aria-label')).toBe('Search players');
  });

  it('names the user’s link even where the name is hidden', () => {
    const top = render(session({ user: { id: 1, username: 'e2eadmin', role: 'admin', totpEnabled: false, prefs: DEFAULT_PREFS } }));
    const link = top.querySelector('a.studio-user')!;
    expect(link.getAttribute('href')).toBe('/settings');
    expect(link.getAttribute('aria-label')).toBe('Your settings (signed in as e2eadmin)');
    expect(link.querySelector('span')!.textContent).toBe('e2eadmin');
    expect(top.querySelector('.studio-anon')).toBeNull();
  });

  it('offers sign-up (when the server takes sign-ups) and sign-in when signed out', () => {
    const anon = render(session());
    expect(anon.querySelector('a.studio-signup')!.getAttribute('href')).toBe('/signup');
    expect(anon.querySelector('a.signin')!.getAttribute('href')).toBe('/login?next=%2Fstudio');
    expect(anon.querySelector('a.signin')!.textContent).toBe('Sign in');
    expect(render(session({ signupMode: 'closed' })).querySelector('a.studio-signup')).toBeNull();
    expect(render(session({ setupRequired: true })).querySelector('a.studio-signup')).toBeNull();
    expect(render(null).querySelector('.studio-anon, a.studio-user')).toBeNull(); // session still unknown
  });

  it('folds the nav into lila’s hamburger where the SPA folds its own', () => {
    expect(lilaVariables).toMatch(/^\$topnav-visible: 1180px;/m);
    expect(layoutCss).toContain('@media (max-width: 1179.98px)');
    expect(studioCss).toContain('@media (max-width: 1179.98px)');
    expect(studioCss).toContain('@media (min-width: 1180px)');
  });

  it('keeps the user’s icon and name on one line, shrinking the name instead of wrapping it', () => {
    const link = declarations(studioCss, '.site-buttons .studio-user');
    expect(link).toMatch(/display:\s*flex/);
    expect(link).toMatch(/white-space:\s*nowrap/);
    const name = declarations(studioCss, '.site-buttons .studio-user span');
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(declarations(studioCss, '#top .site-buttons')).toMatch(/min-width:\s*0/);
    expect(declarations(studioCss, '#top .site-title-nav')).toMatch(/flex-shrink:\s*0/);
  });
});
