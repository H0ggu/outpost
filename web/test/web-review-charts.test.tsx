/**
 * The time axes of the profile charts (web review): day-month labels and three-letter months
 * instead of d3's default mix of formats.
 */
import { describe, expect, it } from 'vitest';
import { MONTHS_SHORT, timeTickFormat } from '../src/app/pages/profile/format.ts';

describe('time axis labels', () => {
  const d = (...a: [number, number, number, number?]) => new Date(Date.UTC(a[0], a[1], a[2], a[3] ?? 0));

  it('writes day ticks day first', () => {
    const ticks = [d(2026, 9, 25), d(2026, 10, 1), d(2026, 10, 8)];
    expect(ticks.map(timeTickFormat(ticks, 'UTC'))).toEqual(['25 Oct', '1 Nov', '8 Nov']);
  });

  it('names months, with the year where one starts', () => {
    const ticks = [d(2025, 11, 1), d(2026, 0, 1), d(2026, 1, 1), d(2026, 8, 1)];
    expect(ticks.map(timeTickFormat(ticks, 'UTC'))).toEqual(['Dec', 'Jan 2026', 'Feb', 'Sep']);
  });

  it('shows yearly ticks as years and hours as times', () => {
    const years = [d(2024, 0, 1), d(2025, 0, 1), d(2026, 0, 1)];
    expect(years.map(timeTickFormat(years, 'UTC'))).toEqual(['2024', '2025', '2026']);
    const hours = [d(2026, 10, 7, 12), d(2026, 10, 8), d(2026, 10, 8, 12)];
    expect(hours.map(timeTickFormat(hours, 'UTC'))).toEqual(['12:00', '8 Nov', '12:00']);
  });

  it('uses the same three-letter months as the activity charts', () => {
    expect(MONTHS_SHORT[8]).toBe('Sep');
    expect(MONTHS_SHORT).toHaveLength(12);
  });
});
