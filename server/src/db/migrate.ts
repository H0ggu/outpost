/**
 * SQL migrations (PLAN §4). Files in `src/db/migrations/` are named `NNN_snake_name.sql` and
 * applied once each, in numeric order, each inside its own transaction; applied versions are
 * recorded in `schema_migrations`.
 *
 * Number ranges per module: core 001–099, auth 100–199, sync/jobs 200–299, stats 300–399,
 * explorer 400–499, profiles/db/files 500–599, reference/broadcasts 600–699, prep 700–799.
 * Never edit an applied migration; add a new one.
 *
 * A migration that rebuilds tables (the SQLite "12-step" ALTER) can put the line
 * `-- outpost:foreign-keys-off` anywhere in the file: foreign keys are then disabled around its
 * transaction and `PRAGMA foreign_key_check` must pass before they are re-enabled.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.ts';

/** Default migrations directory. */
export const MIGRATIONS_DIR: string = fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const FK_OFF_MARKER = '-- outpost:foreign-keys-off';

/** A migration file on disk. */
export interface Migration {
  version: number;
  name: string;
  file: string;
}

/** Migration files in `dir`, sorted by version. Throws on duplicate versions or bad names. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  const seen = new Map<number, string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue;
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`Bad migration file name: ${f} (expected NNN_snake_name.sql)`);
    const version = Number(m[1]);
    const prev = seen.get(version);
    if (prev) throw new Error(`Duplicate migration version ${version}: ${prev} and ${f}`);
    seen.set(version, f);
    out.push({ version, name: m[2]!, file: join(dir, f) });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** Applies pending migrations. Returns the ones applied now. */
export function migrate(
  db: Db,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): { applied: Migration[]; current: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);
  const done = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map(r => r.version));
  const applied: Migration[] = [];

  for (const m of listMigrations(opts.dir)) {
    if (done.has(m.version)) continue;
    const sql = readFileSync(m.file, 'utf8');
    const fkOff = sql.includes(FK_OFF_MARKER);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.tx(() => {
        db.exec(sql);
        if (fkOff) {
          const bad = db.all('PRAGMA foreign_key_check');
          if (bad.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(bad.slice(0, 5))}`);
        }
        db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.name,
          Date.now(),
        ]);
      });
    } catch (e) {
      throw new Error(`Migration ${basename(m.file)} failed: ${(e as Error).message}`, { cause: e });
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
    opts.log?.(`applied migration ${basename(m.file)}`);
    applied.push(m);
  }
  const current = db.value<number>('SELECT COALESCE(MAX(version), 0) FROM schema_migrations') ?? 0;
  return { applied, current };
}
