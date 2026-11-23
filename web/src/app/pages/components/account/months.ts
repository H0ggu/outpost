/** Broadcast-month helpers of the admin reference page (PLAN §6 `BroadcastMonthStatus`). */
import type { BroadcastMonthStatus, IsoMonth } from '@outpost/shared/api';

/** Short English month names, January first. */
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2024-05` → `May 2024`. */
export const monthLabel = (m: IsoMonth): string => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7)} ${m.slice(0, 4)}`;

/** A month can be (re-)imported unless it is already queued or importing. */
export const selectableMonth = (m: BroadcastMonthStatus): boolean => m.status !== 'queued' && m.status !== 'importing';

/**
 * Months as calendar rows, newest year first: `[year, twelve slots]`, each slot the month's
 * status or null when that month is not listed (before the first dump, or not published yet).
 */
export function groupMonthsByYear(months: readonly BroadcastMonthStatus[]): Array<[string, Array<BroadcastMonthStatus | null>]> {
  const years = new Map<string, Array<BroadcastMonthStatus | null>>();
  for (const m of months) {
    if (!/^\d{4}-\d{2}$/.test(m.month)) continue;
    const year = m.month.slice(0, 4);
    const index = Number(m.month.slice(5, 7)) - 1;
    if (index < 0 || index > 11) continue;
    let row = years.get(year);
    if (!row) {
      row = Array.from({ length: 12 }, () => null);
      years.set(year, row);
    }
    row[index] = m;
  }
  return [...years.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
}
