import { join } from 'node:path';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { describe, expect, it } from 'vitest';
import { posKey, posKeyOf } from '../src/chess/posKey.ts';
import { ConfigError, loadConfig, ROOT_DIR } from '../src/config.ts';
import { isSpaPath } from '../src/app.ts';
import { DEFAULT_SETTINGS, readSettings, userAgent, writeSettings } from '../src/settings.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';

describe('config', () => {
  it('has dev defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ env: 'development', port: 8080, host: '0.0.0.0', publicOrigin: null, trustProxy: false });
    expect(c.dataDir).toBe(join(ROOT_DIR, 'data'));
    expect(c.dbPath).toBe(join(ROOT_DIR, 'data', 'outpost.db'));
    expect(c.openingsDir).toBe(join(ROOT_DIR, 'server', 'data', 'openings'));
  });

  it('treats empty values as unset and normalises PUBLIC_ORIGIN', () => {
    const c = loadConfig({ LICHESS_TOKEN: '', PUBLIC_ORIGIN: 'https://Chess.Example.com/', PORT: '9000' });
    expect(c.lichessToken).toBeNull();
    expect(c.publicOrigin).toBe('https://chess.example.com');
    expect(c.secureCookies).toBe(true);
    expect(c.port).toBe(9000);
  });

  it('requires PUBLIC_ORIGIN in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://10.0.0.2:8080' }).isProduction).toBe(true);
  });

  it('parses TRUSTED_PROXIES', () => {
    expect(loadConfig({ TRUSTED_PROXIES: 'loopback, 10.0.0.0/8,fd00::/8' }).trustProxy).toEqual([
      'loopback',
      '10.0.0.0/8',
      'fd00::/8',
    ]);
    expect(loadConfig({ TRUSTED_PROXIES: 'true' }).trustProxy).toBe(true);
    expect(() => loadConfig({ TRUSTED_PROXIES: 'example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow(ConfigError);
  });

  it('rejects malformed values', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://x.example/path' })).toThrow(ConfigError);
    expect(() => loadConfig({ LICHESS_TOKEN: 'lip_bad token' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError);
  });
});

describe('settings', () => {
  it('reads defaults, stored values and env overrides', () => {
    const db = openDb(':memory:');
    migrate(db);
    const config = loadConfig({});
    expect(readSettings(db, config)).toEqual(DEFAULT_SETTINGS);
    writeSettings(db, { signupMode: 'invite', lichessToken: 'lip_ui', autoRefreshHourUtc: 3 });
    expect(readSettings(db, config)).toMatchObject({ signupMode: 'invite', lichessToken: 'lip_ui', autoRefreshHourUtc: 3 });
    expect(readSettings(db, loadConfig({ LICHESS_TOKEN: 'lip_env' })).lichessToken).toBe('lip_env');
    expect(() => writeSettings(db, { autoRefreshHourUtc: 24 })).toThrow();
    db.run("UPDATE instance_settings SET value = '\"bogus\"' WHERE key = 'signupMode'");
    expect(readSettings(db, config).signupMode).toBe('closed');
    db.close();
  });

  it('builds the upstream User-Agent', () => {
    expect(userAgent('1.2.3', 'me@example.com')).toBe('Outpost/1.2.3 (self-hosted; contact: me@example.com)');
    expect(userAgent('1.2.3', null)).toBe('Outpost/1.2.3 (self-hosted)');
  });
});

describe('posKey', () => {
  const play = (sans: string[]): Chess => {
    const pos = Chess.default();
    for (const s of sans) pos.play(parseSan(pos, s)!);
    return pos;
  };

  it('is a stable 53-bit integer', () => {
    const k = posKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    expect(Number.isSafeInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBe(posKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'));
  });

  it('merges transpositions and separates different positions', () => {
    expect(posKeyOf(play(['d4', 'Nf6', 'c4', 'e6']))).toBe(posKeyOf(play(['c4', 'e6', 'd4', 'Nf6'])));
    expect(posKeyOf(play(['e4']))).not.toBe(posKeyOf(play(['d4'])));
  });
});

describe('isSpaPath', () => {
  it('routes client paths to the SPA only', () => {
    expect(isSpaPath('/')).toBe(true);
    expect(isSpaPath('/u/magnus/games')).toBe(true);
    expect(isSpaPath('/api/health')).toBe(false);
    expect(isSpaPath('/assets/x.js')).toBe(false);
    expect(isSpaPath('/lichess/piece/cburnett/wK.svg')).toBe(false);
    expect(isSpaPath('/favicon.ico')).toBe(false);
  });
});
