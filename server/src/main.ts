/**
 * Entry point: config → data dir → db → migrate → app.listen, with graceful shutdown.
 * Run with `node server/src/main.ts` (Node ≥ 26.11 strips the types).
 */
import { accessSync, constants, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';

function prepareDataDir(config: Config): void {
  for (const dir of [config.dataDir, config.nnueDir, config.uploadsDir]) mkdirSync(dir, { recursive: true });
  try {
    accessSync(config.dataDir, constants.W_OK);
  } catch {
    throw new Error(
      `DATA_DIR ${config.dataDir} is not writable by uid ${process.getuid?.() ?? '?'}. ` +
        'With Docker on Linux, create it first and give it to uid 1000: mkdir -p data && sudo chown 1000:1000 data',
    );
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  prepareDataDir(config);
  const db = openDb(config.dbPath);
  const { applied, current } = migrate(db);

  const app = await buildApp({ config, db });
  for (const m of applied) app.log.info(`applied migration ${basename(m.file)}`);
  app.log.info({ schema: current, dataDir: config.dataDir, version: config.version }, 'database ready');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => {
      app.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      await app.close();
    } finally {
      db.close();
      clearTimeout(force);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  if (!config.publicOrigin) app.log.warn('PUBLIC_ORIGIN is not set: only same-host localhost requests pass the Origin check (dev mode); set it to use another address');
}

main().catch(e => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
