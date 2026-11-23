import type { LiconValue } from '../../lichess/licon.ts';

export { licon } from '../../lichess/licon.ts';
export type { LiconValue } from '../../lichess/licon.ts';

/** A glyph of the lichess icon font: `<Icon glyph={licon.Search} />`. Decorative unless `title` is set. */
export function Icon({ glyph, title, className }: { glyph: LiconValue; title?: string; className?: string }) {
  return (
    <i
      data-icon={glyph}
      className={className}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  );
}
