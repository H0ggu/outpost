import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSettings } from '../src/settings.ts';
import {
  JOB_RETENTION,
  pruneFinishedJobs,
  readSchedulerState,
  runAutoRefreshIfDue,
  Scheduler,
  syncDedupeKey,
} from '../src/jobs/index.ts';
import { createSource, createUserSession, makeTestApp, type TestApp } from './helpers.ts';

const DAY = 86_400_000;

describe('scheduler', () => {
  let t: TestApp;
  let auto: number[];
  let manualOnly: number;

  beforeEach(async () => {
    t = await makeTestApp();
    writeSettings(t.db, { autoRefreshHourUtc: 6 });
    const { userId } = createUserSession(t.db, { username: 'owner' });
    const profile = (slug: string, autoRefresh: boolean) =>
      t.db.run('INSERT INTO profiles (slug, display_name, owner_user_id, auto_refresh, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)', [
        slug,
        slug,
        userId,
        autoRefresh,
      ]).lastInsertRowid;
    const on = profile('auto-on', true);
    const off = profile('auto-off', false);
    const lichess = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    const chesscom = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    const fide = createSource(t.db, { kind: 'fide', key: '999001' });
    manualOnly = createSource(t.db, { kind: 'lichess', key: 'manual-only' });
    // The Lichess source is in both profiles: it is refreshed once.
    t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)', [
      on,
      lichess,
      on,
      chesscom,
      on,
      fide,
      off,
      lichess,
      off,
      manualOnly,
    ]);
    auto = [lichess, chesscom];
  });
  afterEach(async () => t.close());

  const syncJobs = () => t.db.all<{ dedupe_key: string; priority: number; user_id: number | null }>("SELECT dedupe_key, priority, user_id FROM jobs WHERE kind = 'sync' ORDER BY id");

  it('enqueues the daily auto refresh once the hour is reached, once per UTC day', () => {
    const day = Date.UTC(2026, 10, 23);
    expect(runAutoRefreshIfDue(t.db, t.config, day + 5 * 3_600_000)).toBeNull();
    const jobs = runAutoRefreshIfDue(t.db, t.config, day + 6 * 3_600_000 + 1);
    expect(jobs?.map(j => j.lane)).toEqual(['lichess', 'chesscom']);
    expect(syncJobs()).toEqual(auto.map(id => ({ dedupe_key: syncDedupeKey(id), priority: 0, user_id: null })));
    expect(readSchedulerState(t.db, 'autoRefresh.lastDay')).toBe('2026-11-23');
    expect(runAutoRefreshIfDue(t.db, t.config, day + 23 * 3_600_000)).toBeNull();
    // Next day: the previous jobs are still queued, so nothing is duplicated.
    expect(runAutoRefreshIfDue(t.db, t.config, day + DAY + 7 * 3_600_000)?.length).toBe(2);
    expect(syncJobs()).toHaveLength(2);
    expect(t.db.value('SELECT COUNT(*) FROM jobs WHERE dedupe_key = ?', [syncDedupeKey(manualOnly)])).toBe(0);
  });

  it('remembers the last run across restarts and catches up after downtime', async () => {
    const day = Date.UTC(2026, 10, 23);
    runAutoRefreshIfDue(t.db, t.config, day + 10 * 3_600_000);
    t.db.run('DELETE FROM jobs');
    // A "restarted" scheduler on the same database does not run again the same day…
    const s1 = new Scheduler({ db: t.db, config: t.config, log: t.app.log, now: () => day + 12 * 3_600_000 });
    s1.tick();
    expect(syncJobs()).toHaveLength(0);
    // …but does when the server was down at the hour on a later day.
    const s2 = new Scheduler({ db: t.db, config: t.config, log: t.app.log, now: () => day + 3 * DAY + 20 * 3_600_000 });
    s2.tick();
    expect(syncJobs()).toHaveLength(2);
    expect(readSchedulerState(t.db, 'autoRefresh.lastDay')).toBe('2026-11-26');
  });

  it('runs periodic tasks at their interval and survives task errors', () => {
    let clock = Date.UTC(2026, 10, 23, 1);
    const runs: number[] = [];
    const s = new Scheduler({
      db: t.db,
      config: t.config,
      log: t.app.log,
      now: () => clock,
      tasks: [
        { name: 'every10', everyMs: 10 * 60_000, run: now => void runs.push(now) },
        {
          name: 'broken',
          everyMs: 0,
          run: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    s.tick();
    clock += 5 * 60_000;
    s.tick();
    clock += 6 * 60_000;
    s.tick();
    expect(runs).toEqual([Date.UTC(2026, 10, 23, 1), Date.UTC(2026, 10, 23, 1, 11)]);
    expect(readSchedulerState(t.db, 'task.every10.lastRunAt')).toBe(Date.UTC(2026, 10, 23, 1, 11));
  });

  it('starts and stops its timer', () => {
    const s = new Scheduler({ db: t.db, config: t.config, log: t.app.log, tickMs: 60_000 });
    s.start();
    s.start();
    s.stop();
    s.stop();
  });

  it('prunes finished jobs past their retention, keeping active ones', () => {
    const now = Date.UTC(2026, 10, 23);
    const insert = (status: string, finishedAgo: number | null) =>
      t.db.run('INSERT INTO jobs (kind, lane, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?)', [
        'rebuild',
        'local',
        status,
        now - 100 * DAY,
        finishedAgo === null ? null : now - finishedAgo,
      ]).lastInsertRowid;
    const keep = [
      insert('queued', null),
      insert('done', JOB_RETENTION.doneMs - DAY),
      insert('error', JOB_RETENTION.errorMs - DAY),
      insert('error', JOB_RETENTION.doneMs + DAY),
    ];
    insert('done', JOB_RETENTION.doneMs + DAY);
    insert('cancelled', JOB_RETENTION.doneMs + DAY);
    insert('error', JOB_RETENTION.errorMs + DAY);
    expect(pruneFinishedJobs(t.db, now, JOB_RETENTION)).toBe(3);
    expect(t.db.all<{ id: number }>('SELECT id FROM jobs ORDER BY id').map(r => r.id)).toEqual(keep);
  });
});
