import type { KeyboardEvent, ReactNode } from 'react';

/** A column of `Table`. */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  /** `num` right-aligns with tabular figures. */
  align?: 'left' | 'right' | 'center' | 'num';
  className?: string;
  width?: string;
  /** Hide below this viewport width (px) to keep phones readable. */
  hideBelow?: number;
}

/** Props of `Table`. */
export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string | number;
  /** Makes rows clickable (and keyboard-activatable with Enter). */
  onRowClick?: (row: T) => void;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
  caption?: ReactNode;
  className?: string;
}

const alignClass = (a: Column<unknown>['align']): string | undefined =>
  a === 'right' ? 'align-right' : a === 'center' ? 'align-center' : a === 'num' ? 'num' : undefined;

/** lila's `.slist` table, horizontally scrollable on small screens. */
export function Table<T>({ columns, rows, rowKey, onRowClick, empty, caption, className }: TableProps<T>) {
  const hideStyle = columns
    .filter(c => c.hideBelow)
    .map(c => `@media (max-width:${c.hideBelow}px){.slist [data-col="${c.key}"]{display:none}}`)
    .join('');
  const onKey = (row: T) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter') onRowClick?.(row);
  };
  return (
    <div className="table-wrap">
      {hideStyle && <style>{hideStyle}</style>}
      <table className={['slist', className].filter(Boolean).join(' ')}>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} data-col={c.key} className={alignClass(c.align)} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className={onRowClick ? 'clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? onKey(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map(c => (
                  <td key={c.key} data-col={c.key} className={[alignClass(c.align), c.className].filter(Boolean).join(' ') || undefined}>
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
