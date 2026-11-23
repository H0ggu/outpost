/**
 * Request validation helpers. Use these instead of hand-rolled checks so every module answers
 * bad input the same way: 400 `{error:{code:'validation', message, details:{issues}}}`.
 *
 *   const body = parseBody(createProfileSchema, req.body);
 *   const { slug } = parseParams(slugParams, req.params);
 *   const filters = parseFiltersQuery(req.query);
 */
import { parseFilters, type ProfileFilters } from '@outpost/shared/filters';
import { SLUG_RE } from '@outpost/shared/api';
import { z, ZodError } from 'zod';
import { validationError, zodIssues } from './errors.ts';

/** Parses `data` with `schema`, throwing a 400 validation HttpError on failure. */
export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = zodIssues(r.error);
  const first = issues[0];
  throw validationError(first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid input', {
    issues,
  });
}

/** Validates a JSON body. */
export const parseBody = parseWith;
/** Validates `req.query`. */
export const parseQuery = parseWith;
/** Validates `req.params`. */
export const parseParams = parseWith;

/** Strict `ProfileFilters` from `req.query` (other query keys are ignored). */
export function parseFiltersQuery(query: unknown): ProfileFilters {
  try {
    return parseFilters((query ?? {}) as Record<string, string>);
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = zodIssues(e);
      throw validationError(issues[0] ? `${issues[0].path}: ${issues[0].message}` : 'Invalid filters', { issues });
    }
    throw e;
  }
}

/** Positive integer id from a path or query string. */
export const zId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** `{ id }` path params. */
export const idParams = z.object({ id: zId });

/** `{ slug }` path params. */
export const slugParams = z.object({ slug: z.string().regex(SLUG_RE, 'invalid profile slug') });

/** `page` / `pageSize` query with a default page size and an upper bound. */
export const pageQuery = (defaultSize: number, maxSize = 100) =>
  z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(maxSize).default(defaultSize),
  });
