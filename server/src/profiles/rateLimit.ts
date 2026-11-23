import type { FastifyRequest } from 'fastify';

/**
 * `config.rateLimit` of a route throttled per signed-in user rather than per IP: it runs as a
 * preHandler hook after the route's own (`requireUser`), so `req.user` is known. Each route keeps
 * its own counters. Used by routes/{databases,files,prep,profiles}.ts.
 */
export const perUserRateLimit = (max: number, timeWindow = 60_000) =>
  ({ max, timeWindow, hook: 'preHandler', keyGenerator: (req: FastifyRequest) => `user:${req.user?.id ?? req.ip}` }) as const;
