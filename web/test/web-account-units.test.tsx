import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BroadcastMonthStatus } from '@outpost/shared/api';
import { ApiError } from '../src/app/api/client.ts';
import { draftOf, settingsPatch, settingsProblems } from '../src/app/pages/components/account/adminSettings.ts';
import { groupSecret, totpQrSrc } from '../src/app/pages/components/account/AccountSections.tsx';
import {
  describeUserAgent,
  formatBytes,
  formatDuration,
  hourLabel,
  relativeTime,
  timeFormat,
} from '../src/app/pages/components/account/format.ts';
import { describeError, fieldErrorsFrom, formErrors, newPasswordProblems, usernameProblem } from '../src/app/pages/components/account/forms.tsx';
import { inviteLink, inviteState } from '../src/app/pages/components/account/invites.ts';
import { progressCounts, progressPercent, progressText } from '../src/app/pages/components/account/JobProgress.tsx';
import { safeNext } from '../src/app/pages/components/account/misc.tsx';
import { groupMonthsByYear, isBuiltinBroadcastDb, monthLabel, selectableMonth } from '../src/app/pages/components/account/months.ts';
import { loadNotice, renderInline, renderMarkdown } from '../src/app/pages/components/account/NoticeDialog.tsx';
import { adminSettings, invite, job, NOW, referenceDb } from './web-account-helpers.tsx';
// The repository's Dockerfile, as text.
import dockerfile from '../../Dockerfile?raw';

describe('format helpers', () => {
  it('formats bytes, durations and hours', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(12_500_000_000)).toBe('13 GB');
    expect(formatBytes(-1)).toBe('–');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(3 * 60 + 5)).toBe('3m 5s');
    expect(formatDuration(2 * 3600 + 120)).toBe('2h 2m');
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(hourLabel(9)).toBe('09:00');
  });

  it('says how long ago or until', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 hours ago');
    expect(relativeTime(NOW + 3 * 86_400_000, NOW)).toBe('in 3 days');
    expect(relativeTime(NOW - 86_400_000, NOW)).toBe('yesterday');
  });

  it('formats dates in UTC when asked', () => {
    const utc = timeFormat('utc');
    expect(utc.timeZone).toBe('UTC');
    expect(utc.dateTime(NOW)).toBe('23 Nov 2026, 12:00 UTC');
    expect(utc.date(NOW)).toBe('23 Nov 2026');
    expect(timeFormat('local').timeZone).toBeUndefined();
  });

  it('describes user agents', () => {
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Version/19.0 Mobile Safari/604.1')).toBe('Safari on iPhone');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Windows');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537.36 Edg/140.0')).toBe('Edge on Windows');
    expect(describeUserAgent('curl/8.9.1')).toBe('curl');
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe('API errors in forms', () => {
  const validation = new ApiError(400, 'validation', 'username: too short', {
    issues: [
      { path: 'username', message: 'too short' },
      { path: 'password', message: 'too weak' },
    ],
  });

  it('maps zod and Fastify issues to fields', () => {
    expect(fieldErrorsFrom(validation)).toEqual({ username: 'too short', password: 'too weak' });
    expect(fieldErrorsFrom(new ApiError(400, 'validation', 'x', { issues: [{ instancePath: '/months/0', message: 'bad month' }] }))).toEqual({
      months: 'bad month',
    });
    expect(fieldErrorsFrom(new ApiError(401, 'unauthorized', 'x'))).toEqual({});
    expect(fieldErrorsFrom(new Error('x'))).toEqual({});
  });

  it('keeps placed issues at their fields and the rest at the form', () => {
    expect(formErrors(validation, ['username', 'password'])).toEqual({ field: { username: 'too short', password: 'too weak' }, form: null });
    const partial = formErrors(validation, ['username']);
    expect(partial.field).toEqual({ username: 'too short' });
    expect(partial.form).toBe('username: too short');
    expect(formErrors(null, ['a'], { a: 'client says no', b: null })).toEqual({ field: { a: 'client says no' }, form: null });
    expect(formErrors(new ApiError(403, 'forbidden', 'Nope'), ['a']).form).toBe('Nope');
  });

  it('explains transport and throttling errors', () => {
    expect(describeError(new ApiError(0, 'network', 'x'))).toMatch(/Cannot reach the Outpost server/);
    expect(describeError(new ApiError(429, 'rate_limited', 'x'))).toMatch(/Too many attempts/);
    expect(describeError(new ApiError(403, 'csrf', 'x'))).toMatch(/origin check/);
    expect(describeError(new ApiError(413, 'payload_too_large', 'HTTP 413'))).toBe('The upload is too large.');
    expect(describeError(new ApiError(500, 'internal', 'Internal server error'))).toMatch(/unexpected error/);
    expect(describeError(new DOMException('x', 'AbortError'))).toBe('Cancelled.');
  });

  it('checks new passwords', () => {
    expect(newPasswordProblems('short', 'short')).toEqual({ password: 'Use at least 8 characters.' });
    expect(newPasswordProblems('long enough', 'different')).toEqual({ confirm: 'The passwords do not match.' });
    expect(newPasswordProblems('long enough', 'long enough')).toEqual({});
  });
});

describe('safeNext', () => {
  it('only allows same-origin paths that are not auth pages', () => {
    expect(safeNext('/u/magnus/games?tc=blitz')).toBe('/u/magnus/games?tc=blitz');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('//evil.example/x')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext('/signup')).toBe('/');
    expect(safeNext('/studio?game=3')).toBe('/studio?game=3');
  });

  it('refuses targets that browsers or the router would read as off-site', () => {
    // Browsers drop tabs and newlines in URLs: `/\t/evil.example` becomes `//evil.example`.
    expect(safeNext('/\t/evil.example/')).toBe('/');
    expect(safeNext('/\n/evil.example/')).toBe('/');
    expect(safeNext('/\r/evil.example/')).toBe('/');
    expect(safeNext('/\u0000x')).toBe('/');
    expect(safeNext('/\u007f/x')).toBe('/');
    expect(safeNext('/x\\y')).toBe('/');
    // Dot segments are resolved before the auth-page check.
    expect(safeNext('/./login')).toBe('/');
    expect(safeNext('/u/../signup?x=1')).toBe('/');
    expect(safeNext('/a/../u/magnus')).toBe('/u/magnus');
    expect(safeNext('/login#x')).toBe('/');
    // Fragments and encoded characters are kept.
    expect(safeNext('/u/magnus/games?tc=blitz#top')).toBe('/u/magnus/games?tc=blitz#top');
    expect(safeNext('/search?q=Magnus%20Carlsen')).toBe('/search?q=Magnus%20Carlsen');
    expect(safeNext('/x', '/settings')).toBe('/x');
    expect(safeNext('', '/settings')).toBe('/settings');
  });
});

describe('usernames', () => {
  it('follows the auth server: 2-30 letters, digits, _ and -, starting with a letter or digit', () => {
    expect(usernameProblem('')).toBe('Choose a username.');
    expect(usernameProblem('a')).toBe('Use at least 2 characters.');
    expect(usernameProblem('a'.repeat(31))).toBe('Use at most 30 characters.');
    expect(usernameProblem('-alice')).toMatch(/^Use only letters/);
    expect(usernameProblem('al.ice')).toMatch(/^Use only letters/);
    expect(usernameProblem('Magnus_Carlsen-2')).toBeUndefined();
    expect(usernameProblem('a'.repeat(30))).toBeUndefined();
    expect(usernameProblem('42')).toBeUndefined();
  });
});

describe('admin settings draft', () => {
  const s = adminSettings();

  it('sends only what changed', () => {
    const d = draftOf(s);
    expect(settingsPatch(s, d)).toEqual({});
    expect(settingsPatch(s, { ...d, signupMode: 'open', updateCooldownMinutes: '30' })).toEqual({ signupMode: 'open', updateCooldownMinutes: 30 });
  });

  it('treats the token as write-only', () => {
    const d = draftOf(s);
    expect(d.tokenInput).toBe('');
    expect(settingsPatch(s, { ...d, tokenInput: ' lip_new ' })).toEqual({ lichessToken: 'lip_new' });
    expect(settingsPatch(s, { ...d, clearToken: true })).toEqual({ lichessToken: null });
    // Nothing to clear, or env wins: no token change at all.
    expect(settingsPatch(adminSettings({ lichessToken: { set: false, masked: null, fromEnv: false } }), { ...d, clearToken: true })).toEqual({});
    const env = adminSettings({ lichessToken: { set: true, masked: 'lip_…zz', fromEnv: true } });
    expect(settingsPatch(env, { ...draftOf(env), tokenInput: 'lip_x' })).toEqual({});
  });

  it('clears the Chess.com contact with null and leaves env values alone', () => {
    expect(settingsPatch(s, { ...draftOf(s), chesscomContact: '  ' })).toEqual({ chesscomContact: null });
    expect(settingsPatch(s, { ...draftOf(s), chesscomContact: 'new@example.org' })).toEqual({ chesscomContact: 'new@example.org' });
    const env = adminSettings({ chesscomContactFromEnv: true, chesscomContact: 'env@example.org' });
    expect(draftOf(env).chesscomContact).toBe('');
    expect(settingsPatch(env, draftOf(env))).toEqual({});
  });

  it('sends broadcastAutoImport only to servers that report it', () => {
    expect(settingsPatch(s, { ...draftOf(s), broadcastAutoImport: true })).toEqual({});
    const withIt = adminSettings({ broadcastAutoImport: false });
    expect(settingsPatch(withIt, { ...draftOf(withIt), broadcastAutoImport: true })).toEqual({ broadcastAutoImport: true });
  });

  it('checks ranges and token format', () => {
    const d = draftOf(s);
    expect(settingsProblems(d)).toEqual({});
    const p = settingsProblems({ ...d, updateCooldownMinutes: '-1', initialSyncMonths: '1.5', tokenInput: 'lip bad', chesscomContact: 'x'.repeat(201) });
    expect(Object.keys(p).sort()).toEqual(['chesscomContact', 'initialSyncMonths', 'lichessToken', 'updateCooldownMinutes']);
    expect(settingsProblems({ ...d, updateCooldownMinutes: '' }).updateCooldownMinutes).toBeDefined();
    expect(settingsProblems({ ...d, initialSyncMonths: '601' }).initialSyncMonths).toBeDefined();
  });
});

describe('invites, jobs and months', () => {
  it('builds invite links and states', () => {
    expect(inviteLink('a b', 'https://chess.example')).toBe('https://chess.example/signup?invite=a+b');
    expect(inviteState(invite(), NOW)).toBe('open');
    expect(inviteState(invite({ expiresAt: NOW - 1 }), NOW)).toBe('expired');
    expect(inviteState(invite({ usedAt: NOW - 5, usedBy: { id: 3, username: 'bob' } }), NOW)).toBe('used');
  });

  it('summarises job progress', () => {
    expect(progressPercent(job().progress)).toBe(30);
    expect(progressPercent({ done: 5, total: null, message: null })).toBeNull();
    expect(progressCounts({ done: 0, total: null, message: null, counts: { imported: 1200, duplicates: 0, 'skip:variant': 3 } })).toBe('imported 1,200');
    expect(progressText(job())).toBe('2026-09 · 3 / 10 · imported 120');
    expect(progressText(job({ progress: null }))).toBeNull();
  });

  it('recognises the built-in broadcast database', () => {
    expect(isBuiltinBroadcastDb(referenceDb())).toBe(true);
    expect(isBuiltinBroadcastDb(referenceDb({ id: 2, name: 'TWIC', sourceLabel: 'theweekinchess.com' }))).toBe(false);
    expect(isBuiltinBroadcastDb(referenceDb({ id: 3, sourceLabel: null }))).toBe(false);
  });

  it('lays months out per year, newest first', () => {
    const m = (month: string, status: BroadcastMonthStatus['status'] = 'available'): BroadcastMonthStatus => ({ month, status, games: 0, importedAt: null });
    const rows = groupMonthsByYear([m('2026-02'), m('2025-12', 'imported'), m('2026-01'), m('bogus')]);
    expect(rows.map(([y]) => y)).toEqual(['2026', '2025']);
    expect(rows[0]![1].map(x => x?.month ?? null).slice(0, 3)).toEqual(['2026-01', '2026-02', null]);
    expect(rows[1]![1][11]?.status).toBe('imported');
    expect(monthLabel('2024-05')).toBe('May 2024');
    expect(selectableMonth(m('2024-01', 'importing'))).toBe(false);
    expect(selectableMonth(m('2024-01', 'error'))).toBe(true);
  });

  it('groups TOTP secrets for reading', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('shows the server PNG QR code when it is a data: image, else the SVG', () => {
    const base = { secret: 'S', otpauthUrl: 'otpauth://totp/x', qrSvg: '<svg/>' };
    expect(totpQrSrc({ ...base, qrDataUrl: 'data:image/png;base64,AAAA' })).toBe('data:image/png;base64,AAAA');
    expect(totpQrSrc(base)).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
    // Never an external image (cross-origin isolation, and no third party learns the secret).
    expect(totpQrSrc({ ...base, qrDataUrl: 'https://qr.example/?d=otpauth' })).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
    expect(totpQrSrc({ ...base, qrDataUrl: 'data:text/html,<b>x</b>' })).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
  });
});

describe('NOTICE.md', () => {
  it('is bundled from the repository root', async () => {
    const text = await loadNotice();
    expect(text.startsWith('# Notices and attribution')).toBe(true);
    expect(text).toContain('GNU Affero General Public License');
    expect(text).toContain('CC BY-SA');
  });

  it('is copied into the Docker build stage before the web build', () => {
    const build = /FROM\s+\S+\s+AS\s+build\n([\s\S]*?)(?=\nFROM\s)/.exec(dockerfile)?.[1] ?? '';
    const copy = build.search(/^COPY\s+NOTICE\.md\s/m);
    const run = build.search(/^RUN\s+npm run build/m);
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(copy);
  });
});

describe('NOTICE markdown', () => {
  it('renders headings, nested lists with continuation lines, and inline marks', () => {
    const md = [
      '## Lichess',
      '',
      'Outpost builds on **lichess** (https://github.com/lichess-org).',
      '',
      '- **chessground** 10.5.0 — GPL',
      '- **lila** authors:',
      '  - `web/vendor/lila/`: a copy',
      '    of the UI.',
      '  - icons',
      '- [Docs](https://example.org/docs)',
      'After the list.',
    ].join('\n');
    const { container } = render(<div>{renderMarkdown(md)}</div>);
    expect(container.querySelector('h3')?.textContent).toBe('Lichess');
    const top = container.querySelector('ul')!;
    expect(top.children).toHaveLength(3);
    const nested = top.children[1]!.querySelector('ul')!;
    expect(nested.children).toHaveLength(2);
    expect(nested.children[0]!.textContent).toBe('web/vendor/lila/: a copy of the UI.');
    expect(container.querySelector('code')?.textContent).toBe('web/vendor/lila/');
    const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(links).toEqual(['https://github.com/lichess-org', 'https://example.org/docs']);
    expect(container.querySelectorAll('p')[1]?.textContent).toBe('After the list.');
    expect(container.querySelector('strong')?.textContent).toBe('lichess');
  });

  it('keeps trailing punctuation out of bare links', () => {
    const { container } = render(<p>{renderInline('See https://lichess.org/source.')}</p>);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://lichess.org/source');
    expect(container.textContent).toBe('See https://lichess.org/source.');
  });
});
