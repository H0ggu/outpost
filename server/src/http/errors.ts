/**
 * Uniform API errors (PLAN §6): every failure is `{error:{code, message, details?}}` with the
 * matching HTTP status. Throw an `HttpError` (or use the helpers) anywhere in a route or hook;
 * the error handler in app.ts turns it — and zod / Fastify errors — into that body.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody, ApiErrorCode } from '@outpost/shared/api';
import { ZodError } from 'zod';

/** An error with an HTTP status and an `ApiErrorCode`. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 400 malformed input. */
export const badRequest = (message = 'Bad request', details?: unknown): HttpError =>
  new HttpError(400, 'bad_request', message, details);
/** 400 failed validation. */
export const validationError = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'validation', message, details);
/** 401 not signed in. */
export const unauthorized = (message = 'Sign in required'): HttpError => new HttpError(401, 'unauthorized', message);
/** 403 not allowed. */
export const forbidden = (message = 'Not allowed'): HttpError => new HttpError(403, 'forbidden', message);
/** 404. */
export const notFound = (message = 'Not found'): HttpError => new HttpError(404, 'not_found', message);
/** 409. */
export const conflict = (message: string, details?: unknown): HttpError => new HttpError(409, 'conflict', message, details);
/** 429 throttled. */
export const rateLimited = (message = 'Too many requests', details?: unknown): HttpError =>
  new HttpError(429, 'rate_limited', message, details);
/** 502 upstream returned an error. */
export const upstreamError = (message: string, details?: unknown): HttpError =>
  new HttpError(502, 'upstream_error', message, details);
/** 503 upstream unreachable or not configured (e.g. no Lichess token). */
export const upstreamUnavailable = (message: string, details?: unknown): HttpError =>
  new HttpError(503, 'upstream_unavailable', message, details);

/** Default error code for an HTTP status. */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    case 502:
      return 'upstream_error';
    case 503:
      return 'upstream_unavailable';
    default:
      return status >= 500 ? 'internal' : 'bad_request';
  }
}

/** Builds an error body. */
export const errorBody = (code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

/** Zod issues as a compact, client-friendly list. */
export const zodIssues = (e: ZodError): Array<{ path: string; message: string }> =>
  e.issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message }));

/**
 * Logs a 5xx `HttpError`. An upstream that is down, rate limited or answers an error is an expected
 * state rather than a bug, so it is a warning without a stack; a feature that needs the Lichess
 * token the operator did not configure (`details.reason: 'no_token'`) is only info, or every visit
 * to Broadcasts would add an error line. Anything else is an error with its stack.
 */
function logServerError(req: FastifyRequest, err: HttpError): void {
  const reason = (err.details as { reason?: unknown } | null | undefined)?.reason;
  if (err.code === 'upstream_unavailable' && reason === 'no_token') {
    req.log.info({ code: err.code, reason }, err.message);
  } else if (err.code === 'upstream_unavailable' || err.code === 'upstream_error') {
    req.log.warn({ code: err.code, details: err.details }, err.message);
  } else {
    req.log.error({ err }, err.message);
  }
}

/** Fastify error handler producing `{error:{code,message}}`. Registered first in buildApp. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    if (err.statusCode >= 500) logServerError(req, err);
    void reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    return;
  }
  if (err instanceof ZodError) {
    const issues = zodIssues(err);
    void reply.status(400).send(errorBody('validation', issues[0]?.message ?? 'Invalid input', { issues }));
    return;
  }
  const fe = err as FastifyError;
  if (fe.validation) {
    void reply.status(400).send(errorBody('validation', fe.message, { issues: fe.validation }));
    return;
  }
  const status = typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 600 ? fe.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err }, 'request failed');
    void reply.status(status).send(errorBody('internal', 'Internal server error'));
    return;
  }
  void reply.status(status).send(errorBody(codeForStatus(status), fe.message || 'Request failed'));
}
