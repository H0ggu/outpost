import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import type { LiconValue } from '../../lichess/licon.ts';

/** Visual variant (lila button classes). */
export type ButtonVariant = 'primary' | 'secondary' | 'empty' | 'red' | 'green';

interface CommonProps {
  variant?: ButtonVariant;
  /** `sm` = lila `.button-thin`. */
  size?: 'md' | 'sm';
  /** Icon glyph shown before the label. */
  icon?: LiconValue;
  children?: ReactNode;
}

const classes = (variant: ButtonVariant, size: 'md' | 'sm', extra?: string): string =>
  ['button', variant !== 'primary' && `button-${variant}`, size === 'sm' && 'button-thin', extra]
    .filter(Boolean)
    .join(' ');

/** A lila-style button. Defaults to `type="button"`. */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  className,
  type = 'button',
  children,
  ...rest
}: CommonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={classes(variant, size, className)} data-icon={icon} {...rest}>
      {children}
    </button>
  );
}

/** A link that looks like a button. `reloadDocument` for pages outside the SPA (e.g. /studio). */
export function ButtonLink({
  to,
  variant = 'primary',
  size = 'md',
  icon,
  className,
  reloadDocument,
  children,
  ...rest
}: CommonProps & { to: string; reloadDocument?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link
      to={to}
      reloadDocument={reloadDocument}
      className={classes(variant, size, className)}
      data-icon={icon}
      {...rest}
    >
      {children}
    </Link>
  );
}
