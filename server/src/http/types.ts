/**
 * Fastify type augmentation: what every route can rely on.
 *
 * - `app.config` / `req.server.config`: validated configuration (src/config.ts).
 * - `app.db` / `req.server.db`: the SQLite connection (src/db/index.ts).
 * - `app.upstream`: the shared client for Lichess / Chess.com / other upstream calls
 *   (src/http/upstream.ts). Never call fetch() directly.
 * - `req.user`: the signed-in user, populated by the preHandlers in src/auth/session.ts
 *   (`optionalUser`, `requireUser`, `requireViewer`, `requireAdmin`); null when anonymous or
 *   when no preHandler ran.
 * - `req.sessionHash`: hex SHA-256 of the session cookie when the session is valid.
 */
import type { Id, UserPrefs, UserRole } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Upstream } from './upstream.ts';

/** The signed-in user as the server sees it. */
export interface AuthUser {
  id: Id;
  username: string;
  role: UserRole;
  totpEnabled: boolean;
  prefs: UserPrefs;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    upstream: Upstream;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    sessionHash: string | null;
  }
}
