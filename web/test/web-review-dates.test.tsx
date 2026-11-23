/**
 * The library pages (Prep, Databases, Broadcasts) write dates like the profile and account pages,
 * whatever the browser's language: `23 Nov 2026`, 24-hour clock (web review).
 */
import { describe, expect, it } from 'vitest';
import { formatTourDates } from '../src/app/pages/components/library/broadcast.tsx';
import { formatDate, formatDateTime } from '../src/app/pages/components/library/format.ts';

describe('library dates', () => {
  const t = Date.UTC(2026, 10, 23, 13, 59);

  it('use the same day-month-year style and 24-hour clock as the profile pages', () => {
    expect(formatDate(t, true)).toBe('23 Nov 2026');
    expect(formatDateTime(t, true)).toBe('23 Nov 2026, 13:59 UTC');
    expect(formatDateTime(Date.UTC(2026, 10, 23, 0, 5), true)).toBe('23 Nov 2026, 00:05 UTC');
    expect(formatTourDates([Date.UTC(2026, 10, 12, 12), Date.UTC(2026, 10, 20, 12)])).toMatch(/^12\s?–\s?20 Nov 2026$/);
  });
});
