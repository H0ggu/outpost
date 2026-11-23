import type { TimeClass } from '@outpost/shared/chess';
import { licon, type LiconValue } from '../../lichess/licon.ts';

/** Lichess perf icons per time class (lila ui/lib/src/game/perfIcons.ts). */
export const TIME_CLASS_ICONS: Readonly<Record<TimeClass, LiconValue>> = {
  bullet: licon.Bullet,
  blitz: licon.FlameBlitz,
  rapid: licon.Rabbit,
  classical: licon.Turtle,
  correspondence: licon.PaperAirplane,
  unknown: licon.Clock,
};

/** Display names per time class. */
export const TIME_CLASS_LABELS: Readonly<Record<TimeClass, string>> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Correspondence',
  unknown: 'Unknown',
};

/** The Lichess icon for a time class, with its name as tooltip. `withLabel` also prints the name. */
export function TimeClassIcon({ tc, withLabel = false, className }: { tc: TimeClass; withLabel?: boolean; className?: string }) {
  const label = TIME_CLASS_LABELS[tc];
  return (
    <span className={['tc-icon', className].filter(Boolean).join(' ')} title={label}>
      <i data-icon={TIME_CLASS_ICONS[tc]} aria-hidden />
      {withLabel ? <span> {label}</span> : <span className="visually-hidden">{label}</span>}
    </span>
  );
}
