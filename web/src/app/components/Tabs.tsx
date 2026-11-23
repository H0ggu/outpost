import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { LiconValue } from '../../lichess/licon.ts';

/** One navigation tab. */
export interface TabItem {
  to: string;
  label: ReactNode;
  icon?: LiconValue;
  /** Active only on an exact match (use for index tabs like a profile's Overview). */
  end?: boolean;
}

/** lila's `.tabs-horiz`: route-driven tabs (each tab is a link; the active one is underlined). */
export function Tabs({ items, className, label }: { items: readonly TabItem[]; className?: string; label?: string }) {
  return (
    <nav className={['tabs-horiz', className].filter(Boolean).join(' ')} aria-label={label}>
      {items.map(item => (
        <NavLink key={item.to} to={item.to} end={item.end} data-icon={item.icon} className={({ isActive }) => (isActive ? 'active' : undefined)}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
