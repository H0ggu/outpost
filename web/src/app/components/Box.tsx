import type { ReactNode } from 'react';

/** Props of `Box` and `Card`. */
export interface BoxProps {
  /** Heading shown in the box header (h1 for Box, h2 for Card unless `level` says otherwise). */
  title?: ReactNode;
  /** Buttons / links on the right of the header. */
  actions?: ReactNode;
  /** Heading level of `title`. */
  level?: 1 | 2 | 3;
  /** Pad the body (default true). Turn off for edge-to-edge tables. */
  pad?: boolean;
  className?: string;
  id?: string;
  children?: ReactNode;
}

/** lila's `.box`: the main content container of a page. */
export function Box({ title, actions, level = 1, pad = true, className, id, children }: BoxProps) {
  const H = `h${level}` as const;
  return (
    <section className={['box', className].filter(Boolean).join(' ')} id={id}>
      {(title || actions) && (
        <header className="box__top">
          {title ? <H>{title}</H> : <span />}
          {actions && <div className="box__top__actions">{actions}</div>}
        </header>
      )}
      {pad ? <div className="box__pad">{children}</div> : children}
    </section>
  );
}

/** A smaller box for dashboards (overview cards, report cards). */
export function Card({ level = 2, className, ...rest }: BoxProps) {
  return <Box level={level} className={['card', className].filter(Boolean).join(' ')} {...rest} />;
}
