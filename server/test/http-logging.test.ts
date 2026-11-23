import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { redactUrl } from '../src/http/logging.ts';
import { noNetworkFetch } from './helpers.ts';

describe('request log', () => {
  it('redacts secret query parameters', () => {
    expect(redactUrl('/signup?invite=J4Fqhf8x')).toBe('/signup?invite=[redacted]');
    expect(redactUrl('/api/x?q=hikaru&token=abc&page=2')).toBe('/api/x?q=hikaru&token=[redacted]&page=2');
    expect(redactUrl('/api/search?q=invite')).toBe('/api/search?q=invite');
    expect(redactUrl('/u/hikaru')).toBe('/u/hikaru');
  });

  it('never writes an invite code to the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outpost-log-'));
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'info' });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = await buildApp({ config, db, logger: { level: 'info', stream }, fetch: noNetworkFetch });
    try {
      await app.ready();
      await app.inject({ url: '/signup?invite=SECRETCODE123' });
      await app.inject({ url: '/api/health?token=SECRETTOKEN' });
      const log = lines.join('');
      expect(log).toContain('/signup?invite=[redacted]');
      expect(log).not.toContain('SECRETCODE123');
      expect(log).not.toContain('SECRETTOKEN');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
