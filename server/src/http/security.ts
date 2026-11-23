/**
 * Security headers (PLAN §8.5, §10) and the CSRF / Origin check (PLAN §6).
 *
 * Every response — API, static files, errors, 404s — carries the CSP, cross-origin isolation
 * (COOP same-origin + COEP require-corp, needed by stockfish-web's SharedArrayBuffer), nosniff
 * and the referrer policy. A route may override a header by setting it itself.
 *
 * Every request with a non-safe method must send `X-Outpost: 1` and an `Origin` equal to
 * PUBLIC_ORIGIN. Outside production the request's own host is accepted too, but only when it is a
 * loopback name (localhost, 127.0.0.0/8, [::1]): that covers the Vite dev proxy and `app.inject`
 * tests without letting a DNS-rebinding page (Origin == Host == attacker.example) through. To use
 * the dev server from another device, set PUBLIC_ORIGIN to that address.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import { HttpError } from './errors.ts';

/**
 * Content-Security-Policy, exactly as PLAN §10. `font-src` allows `data:` because pgn-viewer's
 * stylesheet embeds its control icons (the `lpv-fontello` font) as a data URI.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Headers added to every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

/** Adds SECURITY_HEADERS to every reply (unless the route already set one). */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether `req`'s Origin header is acceptable for a state-changing request. */
export function isAllowedOrigin(req: FastifyRequest, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (config.publicOrigin !== null && url.origin === config.publicOrigin) return true;
  if (config.isProduction) return false;
  // Dev/test: accept the request's own loopback host (Vite proxy, app.inject), comparing default ports.
  if (!isLoopbackHostname(url.hostname)) return false;
  let own: URL;
  try {
    own = new URL(`${req.protocol}://${req.host}`);
  } catch {
    return false;
  }
  return url.hostname === own.hostname && effectivePort(url) === effectivePort(own);
}

const effectivePort = (u: URL): string => u.port || (u.protocol === 'https:' ? '443' : '80');

/** `localhost`, `*.localhost`, 127.0.0.0/8 or `[::1]` (a WHATWG URL hostname). */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** Rejects non-safe requests without `X-Outpost: 1` or with a foreign Origin (403 `csrf`). */
export function registerCsrfCheck(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async req => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      throw new HttpError(403, 'csrf', `Missing ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} header`);
    }
    if (!isAllowedOrigin(req, config)) throw new HttpError(403, 'csrf', 'Cross-origin request refused');
  });
}
