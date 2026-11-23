import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES } from '@outpost/shared/api';
import { z } from 'zod';
import { requireViewer } from '../auth/session.ts';
import { HttpError, notFound } from '../http/errors.ts';
import { createNnueStore, NNUE_NAME_RE, NnueError, parseRange } from '../explorer/nnue.ts';

/**
 * Assets routes — PLAN §6 (GET /assets/lifat/nnue/:name), §8 (stockfish-web via lila's ceval).
 *
 *   - GET /assets/lifat/nnue/:name — Stockfish network `^nn-[0-9a-f]{12}\.nnue$`, downloaded once
 *     from tests.stockfishchess.org/api/nn/:name (through app.upstream), verified against the
 *     SHA-256 prefix in its name and stored atomically in config.nnueDir (src/explorer/nnue.ts).
 *
 * A cached network is public, immutable data and is served to anyone (with Range support). A
 * download costs bandwidth and disk, so starting one needs a viewer (signed in, or anonymous
 * browsing on) — lila's ceval fetches it same-origin with the session cookie.
 */
const nnueParams = z.object({ name: z.string().max(40) });

/** HEAD: Fastify keeps our content-length for a stream payload (and drops the body), not for none. */
const emptyBody = (): Readable => Readable.from([]);

const assetRoutes: FastifyPluginAsync = async app => {
  const store = createNnueStore({ dir: app.config.nnueDir, upstream: app.upstream, log: app.log });

  app.get(API_ROUTES.nnue(':name'), { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = nnueParams.safeParse(req.params);
    const name = parsed.success ? parsed.data.name : '';
    if (!NNUE_NAME_RE.test(name)) throw notFound('Unknown NNUE network');

    let file = await store.cached(name);
    if (!file) {
      await requireViewer(req, reply);
      try {
        file = await store.ensure(name);
      } catch (e) {
        if (!(e instanceof NnueError)) throw e;
        switch (e.reason) {
          case 'not_found':
            throw notFound(e.message);
          case 'hash_mismatch':
          case 'too_large':
            throw new HttpError(502, 'upstream_error', e.message, { reason: e.reason });
          case 'quota':
            throw new HttpError(503, 'upstream_unavailable', e.message, { reason: e.reason });
          case 'upstream':
            throw new HttpError(503, 'upstream_unavailable', e.message, { reason: e.reason });
        }
      }
    }

    const etag = `"${name}"`;
    reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .header('last-modified', new Date(file.mtimeMs).toUTCString())
      .header('accept-ranges', 'bytes')
      .type('application/octet-stream');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();

    const range = parseRange(req.headers.range, file.size);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${file.size}`).send();
    }
    if (range) {
      reply
        .status(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
        .header('content-length', range.end - range.start + 1);
      if (req.method === 'HEAD') return reply.send(emptyBody());
      return reply.send(createReadStream(file.path, { start: range.start, end: range.end }));
    }
    reply.header('content-length', file.size);
    if (req.method === 'HEAD') return reply.send(emptyBody());
    return reply.send(createReadStream(file.path));
  });
};

export default assetRoutes;
