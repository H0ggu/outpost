/**
 * The filters bar shared by the Games, Explorer, Openings and Opponents tabs (PLAN §5 "Filters",
 * §9). State lives in the URL query through `useUrlFilters`; every change resets paging.
 *
 * Desktop shows the common filters in one wrapping row with "More filters" for the advanced
 * ones (opened automatically when one is set). Phones show a single "Filters" toggle plus the
 * active filters as removable chips.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ProfileHeader } from '@outpost/shared/api';
import { TIME_CLASSES, type Outcome, type TimeClass } from '@outpost/shared/chess';
import { OPP_STRENGTHS, PERIODS, type OppStrength, type Period, type ProfileFilters } from '@outpost/shared/filters';
import { useUrlFilters } from '../../../api/hooks.ts';
import { licon, TIME_CLASS_ICONS, TIME_CLASS_LABELS } from '../../../components/index.ts';
import { fmtLine, OPP_LABELS, OUTCOME_PLURAL, parseMovesInput, PERIOD_LABELS } from '../format.ts';
import { useOpponentNames } from '../hooks.ts';
import { Segmented, SelectField, SiteIcon, ToggleChip } from './bits.tsx';

const PERIOD_SHORT: Readonly<Record<Period, string>> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '3m': '3 months',
  '6m': '6 months',
  '12m': '12 months',
};

const toggle = <T,>(list: readonly T[] | undefined, v: T): T[] =>
  list?.includes(v) ? list.filter(x => x !== v) : [...(list ?? []), v];

/** One removable description of an active filter. */
export interface ActiveFilter {
  key: string;
  label: string;
  clear: (f: ProfileFilters) => ProfileFilters;
}

/** The active filters as short labels (for chips and counts). */
export function describeFilters(f: ProfileFilters, header?: Pick<ProfileHeader, 'sources'>): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const without = (...keys: Array<keyof ProfileFilters>) => (x: ProfileFilters) => {
    const y = { ...x };
    for (const k of keys) delete y[k];
    return y;
  };
  if (f.color) out.push({ key: 'color', label: f.color === 'white' ? 'As White' : 'As Black', clear: without('color') });
  if (f.period) out.push({ key: 'period', label: PERIOD_LABELS[f.period], clear: without('period') });
  else if (f.from || f.to)
    out.push({ key: 'dates', label: `${f.from ?? '…'} → ${f.to ?? '…'}`, clear: without('from', 'to') });
  if (f.tc?.length) out.push({ key: 'tc', label: f.tc.map(tc => TIME_CLASS_LABELS[tc]).join(', '), clear: without('tc') });
  if (f.src?.length) {
    const names = f.src.map(id => header?.sources.find(s => s.id === id)?.displayName ?? `#${id}`);
    out.push({ key: 'src', label: names.join(', '), clear: without('src') });
  }
  if (f.rated) out.push({ key: 'rated', label: f.rated === 'rated' ? 'Rated' : 'Casual', clear: without('rated') });
  if (f.outcome?.length) out.push({ key: 'outcome', label: f.outcome.map(o => OUTCOME_PLURAL[o]).join(', '), clear: without('outcome') });
  if (f.opp) out.push({ key: 'opp', label: OPP_LABELS[f.opp], clear: without('opp') });
  if (f.oppName) out.push({ key: 'oppName', label: `vs ${f.oppName}`, clear: without('oppName') });
  if (f.event) out.push({ key: 'event', label: `Event: ${f.event}`, clear: without('event') });
  if (f.line?.length) out.push({ key: 'line', label: fmtLine(f.line), clear: without('line') });
  return out;
}

/**
 * A text filter that commits on Enter, on blur, or after a short pause. `suggestions` feed a
 * `<datalist>`; `onFocus` lets the caller load them only when the field is used.
 */
function TextFilter({
  label,
  placeholder,
  value,
  onCommit,
  suggestions,
  onFocus,
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  onCommit: (v: string | undefined) => void;
  suggestions?: readonly string[];
  onFocus?: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);

  const commit = (v: string) => {
    const t = v.trim().slice(0, 100);
    if (t !== (value ?? '')) onCommit(t || undefined);
  };
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  // Commit after a pause in typing.
  useEffect(() => {
    if (text.trim() === (value ?? '')) return;
    const t = setTimeout(() => commitRef.current(text), 700);
    return () => clearTimeout(t);
  }, [text, value]);

  return (
    <span className="field field--text">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <span className="field__input">
        <input
          id={id}
          type="search"
          value={text}
          placeholder={placeholder}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          list={suggestions?.length ? listId : undefined}
          onFocus={onFocus}
          onChange={e => setText(e.target.value)}
          onBlur={() => commit(text)}
          onKeyDown={e => {
            if (e.key === 'Enter') commit(text);
          }}
        />
        {suggestions?.length ? (
          <datalist id={listId}>
            {suggestions.map(v => (
              <option key={v} value={v} />
            ))}
          </datalist>
        ) : null}
      </span>
    </span>
  );
}

/** The position (line) filter: shown as SAN with a clear button, or a moves input. */
function LineFilter({ line, onChange }: { line: string[] | undefined; onChange: (line: string[] | undefined) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (line?.length) {
    return (
      <span className="field field--line">
        <span className="field__label">Line</span>
        <span className="line-chip" title="Only games that reached the position after these moves">
          <span className="san">{fmtLine(line)}</span>
          <button type="button" className="line-chip__clear" data-icon={licon.X} aria-label="Clear the line filter" onClick={() => onChange(undefined)} />
        </span>
      </span>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = parseMovesInput(text);
    if ('error' in r) setError(r.error);
    else {
      setError(null);
      setText('');
      onChange(r.line);
    }
  };

  return (
    <form className="field field--text field--line" onSubmit={submit}>
      <label htmlFor={id} className="field__label">
        Line
      </label>
      <span className="field__input">
        <input
          id={id}
          type="text"
          value={text}
          placeholder="1. e4 c5 2. Nf3"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={e => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="button button-secondary button-thin">
          Set
        </button>
      </span>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}

/**
 * Custom date range inputs. `onEditing` keeps them on screen while a date is being retyped (a
 * half-typed date is empty); `onLeave` runs when focus leaves both inputs.
 */
function DateRange({
  f,
  set,
  onEditing,
  onLeave,
}: {
  f: ProfileFilters;
  set: (patch: Partial<ProfileFilters>) => void;
  onEditing: () => void;
  onLeave: () => void;
}) {
  const change = (key: 'from' | 'to', value: string) => {
    if (!value) onEditing();
    set({ period: undefined, [key]: value || undefined });
  };
  return (
    <span
      className="field field--dates"
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave();
      }}
    >
      <span className="field__label">From – to</span>
      <span className="field__input">
        <input type="date" aria-label="From" value={f.from ?? ''} max={f.to} onChange={e => change('from', e.target.value)} />
        <span className="muted">–</span>
        <input type="date" aria-label="To" value={f.to ?? ''} min={f.from} onChange={e => change('to', e.target.value)} />
      </span>
    </span>
  );
}

/**
 * The filters bar. `sources` come from the profile header (only shown with 2+ accounts).
 * `hideColor` drops the colour control where the page has its own (the Explorer's and the
 * Openings tab's side toggles, which write the same `color` filter).
 */
export function FiltersBar({ header, hideColor = false }: { header: ProfileHeader; hideColor?: boolean }) {
  const [filters, setFilters] = useUrlFilters();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  // "Custom…" picked (or a date being retyped) with no date in the URL yet. Otherwise the URL
  // decides, so clearing the dates (chip, Reset, leaving empty inputs) goes back to "All time".
  const [customPending, setCustomPending] = useState(false);
  const [wantNames, setWantNames] = useState(false);
  const opponentNames = useOpponentNames(header.slug, wantNames);
  const hasDates = !!(filters.from || filters.to);
  useEffect(() => {
    if (hasDates) setCustomPending(false);
  }, [hasDates]);

  const set = (patch: Partial<ProfileFilters>) => setFilters({ ...filters, ...patch });
  // Where the page owns the colour (its side toggle), it is not one of the bar's filters.
  const active = describeFilters(filters, header).filter(a => !(hideColor && a.key === 'color'));
  const reset = () => {
    setCustomPending(false);
    setFilters(hideColor && filters.color ? { color: filters.color } : {});
  };
  // `unknown` only exists for PGN and reference games.
  const timeClasses = TIME_CLASSES.filter(
    tc => tc !== 'unknown' || header.sources.some(s => s.kind === 'pgn' || s.kind === 'fide') || !!filters.tc?.includes('unknown'),
  );
  const advancedActive = !!(filters.src?.length || filters.opp || filters.oppName || filters.event || filters.line?.length);
  const showAdvanced = more || advancedActive;
  const periodValue: Period | '' | 'custom' = filters.period ?? (hasDates || customPending ? 'custom' : '');

  return (
    <section className={['box', 'pfilters', open && 'pfilters--open'].filter(Boolean).join(' ')} aria-label="Filters">
      <div className="pfilters__mobile">
        <button
          type="button"
          className="pfilters__toggle"
          data-icon={licon.Funnel}
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          Filters{active.length > 0 ? ` (${active.length})` : ''}
        </button>
        {active.length > 0 && (
          <ul className="pfilters__chips" aria-label="Active filters">
            {active.map(a => (
              <li key={a.key}>
                <button type="button" className="chip chip--removable" onClick={() => setFilters(a.clear(filters))} aria-label={`Remove filter ${a.label}`}>
                  <span className={a.key === 'line' ? 'san' : undefined}>{a.label}</span>
                  <i data-icon={licon.X} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pfilters__body">
        <div className="pfilters__row">
          {!hideColor && (
          <span className="field">
            <span className="field__label">Colour</span>
            <Segmented
              label="Colour"
              size="sm"
              value={filters.color ?? 'all'}
              options={[
                { value: 'all', label: 'Both' },
                { value: 'white', label: <><span className="color-dot color-dot--white" aria-hidden /> White</> },
                { value: 'black', label: <><span className="color-dot color-dot--black" aria-hidden /> Black</> },
              ]}
              onChange={v => set({ color: v === 'all' ? undefined : v })}
            />
          </span>
          )}

          <SelectField
            label="Period"
            value={periodValue}
            options={[
              { value: '', label: 'All time' },
              ...PERIODS.map(p => ({ value: p, label: PERIOD_SHORT[p] })),
              { value: 'custom', label: 'Custom…' },
            ]}
            onChange={v => {
              if (v === 'custom') {
                setCustomPending(true);
                if (filters.period) set({ period: undefined });
              } else {
                setCustomPending(false);
                set({ period: v || undefined, from: undefined, to: undefined });
              }
            }}
          />
          {periodValue === 'custom' && (
            <DateRange
              f={filters}
              set={set}
              onEditing={() => setCustomPending(true)}
              onLeave={() => {
                if (!hasDates) setCustomPending(false);
              }}
            />
          )}

          <span className="field">
            <span className="field__label">Time control</span>
            <span className="chips" role="group" aria-label="Time control">
              {timeClasses.map((tc: TimeClass) => (
                <ToggleChip
                  key={tc}
                  pressed={!!filters.tc?.includes(tc)}
                  onToggle={() => set({ tc: toggle(filters.tc, tc) })}
                  title={tc === 'unknown' ? 'Unknown time control (PGN games)' : TIME_CLASS_LABELS[tc]}
                >
                  <i data-icon={TIME_CLASS_ICONS[tc]} aria-hidden />
                  <span className="chip__label">{tc === 'correspondence' ? 'Corresp.' : TIME_CLASS_LABELS[tc]}</span>
                </ToggleChip>
              ))}
            </span>
          </span>

          <span className="field">
            <span className="field__label">Rated</span>
            <Segmented
              label="Rated"
              size="sm"
              value={filters.rated ?? 'all'}
              options={[
                { value: 'all', label: 'All' },
                { value: 'rated', label: 'Rated' },
                { value: 'unrated', label: 'Casual' },
              ]}
              onChange={v => set({ rated: v === 'all' ? undefined : v })}
            />
          </span>

          <span className="field">
            <span className="field__label">Result</span>
            <span className="chips" role="group" aria-label="Result">
              {(['w', 'd', 'l'] as const).map((o: Outcome) => (
                <ToggleChip
                  key={o}
                  className={`chip--${o}`}
                  pressed={!!filters.outcome?.includes(o)}
                  onToggle={() => set({ outcome: toggle(filters.outcome, o) })}
                >
                  {OUTCOME_PLURAL[o]}
                </ToggleChip>
              ))}
            </span>
          </span>

          <span className="pfilters__end">
            {!advancedActive && (
              <button
                type="button"
                className="button button-empty button-thin pfilters__more"
                aria-expanded={showAdvanced}
                data-icon={showAdvanced ? licon.UpTriangle : licon.DownTriangle}
                onClick={() => setMore(m => !m)}
              >
                {showAdvanced ? 'Fewer filters' : 'More filters'}
              </button>
            )}
            {active.length > 0 && (
              <button type="button" className="button button-empty button-thin" data-icon={licon.X} onClick={reset}>
                Reset
              </button>
            )}
          </span>
        </div>

        <div className="pfilters__row pfilters__row--advanced" hidden={!showAdvanced}>
          {header.sources.length > 1 && (
            <span className="field">
              <span className="field__label">Accounts</span>
              <span className="chips" role="group" aria-label="Accounts">
                {header.sources.map(s => (
                  <ToggleChip key={s.id} pressed={!!filters.src?.includes(s.id)} onToggle={() => set({ src: toggle(filters.src, s.id) })} title={s.displayName}>
                    <SiteIcon kind={s.kind} />
                    <span className="chip__label">{s.displayName}</span>
                  </ToggleChip>
                ))}
              </span>
            </span>
          )}
          <SelectField
            label="Opponent strength"
            value={filters.opp ?? ''}
            options={[{ value: '', label: 'Any' }, ...OPP_STRENGTHS.map(o => ({ value: o, label: OPP_LABELS[o] }))]}
            onChange={v => set({ opp: (v || undefined) as OppStrength | undefined })}
          />
          <TextFilter
            label="Opponent"
            placeholder="Name or username"
            value={filters.oppName}
            onCommit={v => set({ oppName: v })}
            suggestions={opponentNames}
            onFocus={() => setWantNames(true)}
          />
          <TextFilter label="Event" placeholder="Tournament" value={filters.event} onCommit={v => set({ event: v })} />
          <LineFilter line={filters.line} onChange={line => set({ line })} />
        </div>
      </div>
    </section>
  );
}
