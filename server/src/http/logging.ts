/**
 * What the request log may show. Fastify logs every request URL at info level, and logs are often
 * shipped elsewhere and kept longer than the secrets some URLs carry: an invite link
 * (`/signup?invite=…`) is a valid, unused invite until someone signs up with it. Query parameters
 * that carry such secrets are replaced by `[redacted]` in the logged URL.
 */
import type { FastifyRequest } from 'fastify';

/** Query parameters never written to the log. */
export const SECRET_QUERY_PARAMS = ['invite', 'token', 'code', 'password', 'totp'] as const;

const SECRET_RE = new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.join('|')})=)[^&#]*`, 'gi');

/** `url` with the values of secret query parameters replaced. */
export const redactUrl = (url: string): string => url.replace(SECRET_RE, '$1[redacted]');

/** pino serializers for Fastify's request log lines (`req`): its default fields, the URL redacted. */
export const LOG_SERIALIZERS = {
  req(req: FastifyRequest) {
    return {
      method: req.method,
      url: redactUrl(req.url),
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  },
};
