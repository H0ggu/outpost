/**
 * Fetch wrapper for the Outpost API (PLAN §6).
 *
 * - Same-origin credentials (the session cookie).
 * - Adds `X-Outpost: 1` on every non-GET request (CSRF check).
 * - JSON bodies are serialised; FormData / Blob / string bodies pass through.
 * - Non-2xx responses throw `ApiError` built from `{error:{code,message,details}}`.
 *
 *   const header = await api.get<ProfileHeader>(API_ROUTES.profile(slug));
 *   await api.post<LoginResponse>(API_ROUTES.login, { username, password });
 */
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ApiErrorBody, type ApiErrorCode } from '@outpost/shared/api';
import { withQuery, type QueryValue } from '@outpost/shared/filters';

/** Client-side codes in addition to the server's `ApiErrorCode`s. */
export type ClientErrorCode = ApiErrorCode | 'network';

/** A failed API call. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ClientErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Not signed in (or the session expired). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Not found. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** Query parameters: URLSearchParams (e.g. from `statsQuery`) or a flat record. */
export type Query = URLSearchParams | Record<string, QueryValue>;

/** Options of `request`. */
export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Parse the body as text even when it is JSON (PGN downloads, NDJSON). */
  asText?: boolean;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  502: 'upstream_error',
  503: 'upstream_unavailable',
};

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (body.error?.code) return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
  } catch {
    // not JSON
  }
  return new ApiError(res.status, STATUS_CODES[res.status] ?? 'internal', res.statusText || `HTTP ${res.status}`);
}

/** Low-level request. Prefer `api.get/post/...`. */
export async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  let body: BodyInit | undefined;
  const b = opts.body;
  if (b instanceof FormData || b instanceof Blob || b instanceof URLSearchParams || typeof b === 'string') body = b;
  else if (b !== undefined) {
    body = JSON.stringify(b);
    headers.set('content-type', 'application/json');
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);

  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal ?? null,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the Outpost server');
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!opts.asText && type.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as T;
}

/** Typed shortcuts. */
export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> =>
    request<T>('GET', path, { query, signal }),
  post: <T = void>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, { body }),
  put: <T = void>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, { body }),
  patch: <T = void>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, { body }),
  del: <T = void>(path: string): Promise<T> => request<T>('DELETE', path),
  /** GET as text (PGN). */
  text: (path: string, query?: Query, signal?: AbortSignal): Promise<string> =>
    request<string>('GET', path, { query, signal, asText: true, headers: { accept: '*/*' } }),
  /** GET an NDJSON stream and return its last JSON line (the explorer's final snapshot). */
  ndjsonLast: async <T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> => {
    const text = await request<string>('GET', path, {
      query,
      signal,
      asText: true,
      headers: { accept: 'application/x-ndjson' },
    });
    const lines = text.split('\n').filter(l => l.trim() !== '');
    const last = lines.at(-1);
    if (last === undefined) throw new ApiError(502, 'upstream_error', 'Empty NDJSON response');
    return JSON.parse(last) as T;
  },
};
