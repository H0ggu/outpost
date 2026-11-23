/**
 * Site header in lila's own `#top` markup (lib/css/header/*, compiled into site.css): Outpost's
 * wordmark (our icon, never the lichess logo), the SPA's main navigation (`MAIN_NAV`, the same
 * list and order) as full-page links back to the SPA, a player search that opens the SPA's
 * `/search`, and the user. Below 1180 px (the SPA's breakpoint) lila's hamburger opens the same
 * navigation. studio.css makes it look like the SPA's header.
 */
import type { SessionInfo } from '@outpost/shared/api';
import { h, type VNode } from 'snabbdom';
import { licon } from '../../lichess/licon.ts';
import { MAIN_NAV, paths } from '../../app/paths.ts';

/** What the header reads from the Studio's controller (no lila types, so it is unit-tested). */
export interface HeaderCtrl {
  readonly session: SessionInfo | null;
  loginUrl(): string;
}

const NAV: ReadonlyArray<readonly [href: string, label: string]> = [
  ...MAIN_NAV.map(n => [n.href, n.label] as const),
  [paths.studio(), 'Studio'],
];

export function renderHeader(ctrl: HeaderCtrl): VNode {
  const user = ctrl.session?.user;
  return h('header#top', [
    h('div.site-title-nav', [
      h('input#tn-tg.topnav-toggle.fullscreen-toggle', { attrs: { type: 'checkbox', 'aria-label': 'Navigation' } }),
      h('label.fullscreen-mask', { attrs: { for: 'tn-tg' } }),
      h('label.hbg', { attrs: { for: 'tn-tg', 'aria-label': 'Navigation' } }, [h('span.hbg__in')]),
      h('a.site-title', { attrs: { href: paths.home, title: 'Outpost home' } }, [
        h('img.studio-site-icon', { attrs: { src: '/icons/icon.svg', alt: '', width: 28, height: 28 } }),
        h('span.studio-site-name', 'Outpost'),
      ]),
      h(
        'nav#topnav',
        { attrs: { 'aria-label': 'Main' } },
        NAV.map(([href, label]) =>
          h('section', [h(`a${label === 'Studio' ? '.studio-current' : ''}`, { attrs: { href } }, label)]),
        ),
      ),
    ]),
    h('div.site-buttons', [
      // A plain GET form: /search?q= is the SPA's search page.
      h('form.studio-search', { attrs: { action: paths.search(), method: 'get', role: 'search' } }, [
        h('i', { attrs: { 'data-icon': licon.Search, 'aria-hidden': 'true' } }),
        h('input', {
          attrs: {
            type: 'search',
            name: 'q',
            placeholder: 'Search players',
            'aria-label': 'Search players',
            autocomplete: 'off',
            spellcheck: 'false',
            enterkeyhint: 'search',
          },
        }),
      ]),
      user
        ? h(
            'a.link.studio-user',
            {
              attrs: {
                href: paths.settings,
                // also the link's name where the header has no room for the user's name
                title: `Your settings (signed in as ${user.username})`,
                'aria-label': `Your settings (signed in as ${user.username})`,
                'data-icon': licon.User,
              },
            },
            h('span', user.username),
          )
        : ctrl.session
          ? renderSignIn(ctrl)
          : null,
    ]),
  ]);
}

/** Signed out: the SPA's "Sign up" (when the server takes sign-ups) and "Sign in" links. */
function renderSignIn(ctrl: HeaderCtrl): VNode {
  const session = ctrl.session!;
  return h('div.studio-anon', [
    !session.setupRequired && session.signupMode !== 'closed'
      ? h('a.studio-signup', { attrs: { href: paths.signup() } }, 'Sign up')
      : null,
    h('a.link.studio-user.signin', { attrs: { href: ctrl.loginUrl(), 'data-icon': licon.User } }, h('span', 'Sign in')),
  ]);
}
