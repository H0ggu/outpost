import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Tabs } from '../src/app/components/Tabs.tsx';
import { flagEmoji } from '../src/app/components/FlagEmoji.tsx';
import { WdlBar, wdlSegments } from '../src/app/components/WdlBar.tsx';
import { paths, studioPlayerExplorer } from '../src/app/paths.ts';

describe('wdlSegments (lila explorer bar widths)', () => {
  it('labels every share as a percentage, with its % sign', () => {
    // lila writes "70% | 15 | 15", which reads like game counts next to W/D/L numbers; whether a
    // label fits is left to the stylesheet (container query), not to a fixed 12% / 20% rule.
    const [w, d, l] = wdlSegments(70, 15, 15);
    expect(w).toMatchObject({ key: 'w', width: 70, label: '70%' });
    expect(d).toMatchObject({ key: 'd', width: 15, label: '15%' });
    expect(l).toMatchObject({ key: 'l', width: 15, label: '15%' });
    const [, small, none] = wdlSegments(995, 5, 0);
    expect(small?.label).toBe('1%');
    expect(none?.label).toBe('');
  });

  it('rounds widths to one decimal and handles no games', () => {
    expect(wdlSegments(1, 1, 1).map(s => s.width)).toEqual([33.3, 33.3, 33.3]);
    expect(wdlSegments(0, 0, 0)).toEqual([]);
  });
});

describe('WdlBar', () => {
  it('renders player and colour modes', () => {
    const { container, rerender } = render(<WdlBar w={6} d={2} l={2} />);
    expect(container.querySelector('.win')?.textContent).toBe('60%');
    expect(container.querySelector('.loss')?.getAttribute('style')).toContain('width: 20%');
    rerender(<WdlBar w={6} d={2} l={2} mode="color" />);
    expect(container.querySelector('.white')).not.toBeNull();
    expect(container.querySelector('.black')).not.toBeNull();
    rerender(<WdlBar w={0} d={0} l={0} />);
    expect(container.querySelector('.wdl-bar--empty')).not.toBeNull();
  });
});

describe('Tabs', () => {
  it('marks the active route', () => {
    render(
      <MemoryRouter initialEntries={['/u/magnus/games']}>
        <Tabs
          items={[
            { to: '/u/magnus', label: 'Overview', end: true },
            { to: '/u/magnus/games', label: 'Games' },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Games').className).toBe('active');
    expect(screen.getByText('Overview').className).toBe('');
  });
});

describe('paths and helpers', () => {
  it('builds SPA and Studio links', () => {
    expect(paths.profile('magnus', 'games', { color: 'white', tc: ['blitz'] })).toBe('/u/magnus/games?color=white&tc=blitz');
    expect(paths.studio({ game: 12 })).toBe('/studio?game=12');
    expect(studioPlayerExplorer('magnus', 'black', {}, true)).toBe(
      '/studio?explorer=player%3Amagnus&color=black&filters=_&embed=explorer',
    );
  });

  it('turns country codes into flag emoji', () => {
    expect(flagEmoji('no')).toBe('🇳🇴');
    expect(flagEmoji('GB-ENG')).toBeNull();
  });
});
