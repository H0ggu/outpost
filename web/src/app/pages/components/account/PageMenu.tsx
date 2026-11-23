/**
 * lila's `page-menu` layout (ui/lib/css/layout/_page-menu.scss) with its `subnav`
 * (component/_subnav.scss): a side menu next to the content on wide screens, a scrollable row of
 * links above it on phones. Used by /settings and /admin.
 */
import { useEffect, useRef, type ReactNode } from 'react';
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
  const innerRef = useRef<HTMLDivElement>(null);
  const activeTo = items.find(i => i.active)?.to;

  // On phones the menu is a scrolling row: keep the current section in view (without moving
  // the page vertically, which scrollIntoView could do).
  useEffect(() => {
    const inner = innerRef.current;
    const link = inner?.querySelector<HTMLElement>('a.active');
    if (!inner || !link || inner.scrollWidth <= inner.clientWidth) return;
    const left = link.getBoundingClientRect().left - inner.getBoundingClientRect().left + inner.scrollLeft;
    if (left < inner.scrollLeft || left + link.offsetWidth > inner.scrollLeft + inner.clientWidth)
      inner.scrollLeft = Math.max(0, left - (inner.clientWidth - link.offsetWidth) / 2);
  }, [activeTo]);

  return (
    <div className="acc-page-menu">
      <nav className="acc-subnav" aria-label={label}>
        <div className="acc-subnav__inner" ref={innerRef}>
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
