/**
 * lila's `page-menu` layout (ui/lib/css/layout/_page-menu.scss) with its `subnav`
 * (component/_subnav.scss): a side menu next to the content on wide screens, a scrollable row of
 * links above it on phones. Used by /settings and /admin.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { LiconValue } from '../../../components/index.ts';
import './account.css';

/** One subnav entry. */
export interface SubnavItem {
  to: string;
  label: ReactNode;
  icon?: LiconValue;
  active: boolean;
}

/** Side menu + content. `extra` goes under the links (wide screens only). */
export function PageMenu({
  label,
  items,
  extra,
  children,
}: {
  label: string;
  items: readonly SubnavItem[];
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="acc-page-menu">
      <nav className="acc-subnav" aria-label={label}>
        <div className="acc-subnav__inner">
          {items.map(item => (
            <Link
              key={item.to}
              to={item.to}
              data-icon={item.icon}
              className={item.active ? 'active' : undefined}
              aria-current={item.active ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </div>
        {extra && <div className="acc-subnav__extra">{extra}</div>}
      </nav>
      <div className="acc-page-menu__content">{children}</div>
    </div>
  );
}
