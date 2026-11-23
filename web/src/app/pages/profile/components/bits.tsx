/**
 * Small presentational pieces shared by the profile pages: site badges, segmented controls,
 * toggle chips, a pager, player names, outcome marks and stat tiles.
 */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { GameRowOpponent, SourceKind, SourceSummary, Title } from '@outpost/shared/api';
import type { Color, Outcome } from '@outpost/shared/chess';
import { FlagEmoji, licon, type LiconValue } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { fmtInt, fmtPct, fmtRating, OUTCOME_LABELS, SOURCE_KIND_LABELS } from '../format.ts';

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/**
 * A neutral badge per site (never the sites' logos: NOTICE.md). Lichess and Chess.com use chess
 * figurines from lila's Noto Chess font; FIDE and PGN sources use lila icons.
 */
const SITE_GLYPH: Readonly<Record<SourceKind, { text?: string; icon?: LiconValue }>> = {
  lichess: { text: '♞' },
  chesscom: { text: '♟' },
  fide: { icon: licon.Trophy },
  pgn: { icon: licon.Book },
};

/** Site badge for a source kind, with the site name as tooltip. */
export function SiteIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const g = SITE_GLYPH[kind];
  const label = SOURCE_KIND_LABELS[kind];
  return (
    <span className={['site-icon', `site-icon--${kind}`, className].filter(Boolean).join(' ')} title={label} role="img" aria-label={label}>
      {g.text ?? <i data-icon={g.icon} aria-hidden />}
    </span>
  );
}

/** Title badge (GM, IM, …), lila's `.title-badge`. */
export function TitleBadge({ title }: { title: Title | null | undefined }) {
  if (!title) return null;
  return <span className={['title-badge', title === 'BOT' && 'title-badge--bot'].filter(Boolean).join(' ')}>{title}</span>;
}

/** Short label of a source: badge + display name. */
export function SourceLabel({ source, withName = true }: { source: Pick<SourceSummary, 'kind' | 'displayName'>; withName?: boolean }) {
  return (
    <span className="source-label">
      <SiteIcon kind={source.kind} />
      {withName && <span className="source-label__name">{source.displayName}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Players and outcomes
// ---------------------------------------------------------------------------

/** Opponent name with flag, title and rating, linking to their profile when Outpost has one. */
export function OpponentName({
  opponent,
  profileSlug,
  showRating = true,
}: {
  opponent: Pick<GameRowOpponent, 'name' | 'title' | 'country' | 'rating'>;
  profileSlug?: string | null;
  showRating?: boolean;
}) {
  const name = (
    <>
      <TitleBadge title={opponent.title} />
      <span className="player-name__text">{opponent.name}</span>
    </>
  );
  return (
    <span className="player-name">
      <FlagEmoji code={opponent.country} />
      {profileSlug ? (
        <Link to={paths.profile(profileSlug)} onClick={e => e.stopPropagation()}>
          {name}
        </Link>
      ) : (
        name
      )}
      {showRating && opponent.rating !== null && <span className="player-name__rating">({fmtRating(opponent.rating)})</span>}
    </span>
  );
}

/** A small square marking a win / draw / loss. */
export function OutcomeMark({ outcome }: { outcome: Outcome }) {
  const text = outcome === 'w' ? '+' : outcome === 'd' ? '=' : '−';
  return (
    <span className={`outcome-mark outcome-mark--${outcome}`} title={OUTCOME_LABELS[outcome]} aria-label={OUTCOME_LABELS[outcome]}>
      {text}
    </span>
  );
}

/** A piece-coloured dot for the player's side. */
export function ColorDot({ color }: { color: Color }) {
  const label = color === 'white' ? 'White' : 'Black';
  return <span className={`color-dot color-dot--${color}`} title={label} role="img" aria-label={label} />;
}

/** `W / D / L` counts with outcome colours. */
export function WdlCounts({ w, d, l }: { w: number; d: number; l: number }) {
  return (
    <span className="wdl-counts">
      <span className="good" title="Wins">
        {fmtInt(w)}
      </span>
      <span className="wdl-counts__sep">/</span>
      <span title="Draws">{fmtInt(d)}</span>
      <span className="wdl-counts__sep">/</span>
      <span className="bad" title="Losses">
        {fmtInt(l)}
      </span>
    </span>
  );
}

/** Score as a percentage, tinted when clearly good or bad. */
export function ScoreText({ score }: { score: number | null }) {
  const cls = score === null ? 'muted' : score >= 0.55 ? 'good' : score <= 0.45 ? 'bad' : undefined;
  return <span className={['score-text', cls].filter(Boolean).join(' ')}>{fmtPct(score)}</span>;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** One option of a `Segmented` control. */
export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  icon?: LiconValue;
}

/** A single-choice button group (lila's `.btn-rack`), exposed as a radio group. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  size = 'md',
}: {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: 'md' | 'sm';
}) {
  return (
    <div className={['seg', size === 'sm' && 'seg--sm', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'seg__btn active' : 'seg__btn'}
          title={o.title}
          data-icon={o.icon}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A multi-select toggle chip (`aria-pressed`). */
export function ToggleChip({
  pressed,
  onToggle,
  children,
  title,
  className,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={['chip', pressed && 'active', className].filter(Boolean).join(' ')}
      aria-pressed={pressed}
      title={title}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

/** A labelled `<select>` bound to a string value. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hideLabel?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <span className={['field', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={hideLabel ? 'visually-hidden' : 'field__label'}>
        {label}
      </label>
      <select id={id} value={value} onChange={e => onChange(e.target.value as T)}>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Previous / next pager with the current range (`21–40 of 1,234`). */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pages">
      <button type="button" className="button button-secondary button-thin" data-icon={licon.JumpFirst} disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page" />
      <button type="button" className="button button-secondary button-thin" data-icon={licon.JumpPrev} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" />
      <span className="pager__info">
        {fmtInt(from)}–{fmtInt(to)} of {fmtInt(total)}
      </span>
      <button type="button" className="button button-secondary button-thin" data-icon={licon.JumpNext} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" />
      <button type="button" className="button button-secondary button-thin" data-icon={licon.JumpLast} disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page" />
    </nav>
  );
}

/** A big number with a caption (overview / summary tiles). */
export function StatTile({ value, label, className }: { value: ReactNode; label: ReactNode; className?: string }) {
  return (
    <div className={['stat-tile', className].filter(Boolean).join(' ')}>
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
    </div>
  );
}
