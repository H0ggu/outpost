import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandler, HttpError } from '../src/http/errors.ts';
import { upstreamHttpError, UpstreamError } from '../src/http/upstream.ts';

/** Runs the error handler on `err` and returns the log calls and the reply it sent. */
function handle(err: Error) {
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const log = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [
      level,
      (obj: Record<string, unknown>, msg: string) => logs.push({ level, obj, msg }),
    ]),
  );
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  errorHandler(err, { log } as unknown as FastifyRequest, reply as unknown as FastifyReply);
  return { logs, sent };
}

describe('errorHandler logging', () => {
  it('logs a missing Lichess token at info, without the error object', () => {
    const { logs, sent } = handle(
      new HttpError(503, 'upstream_unavailable', 'The Lichess opening explorer needs a Lichess API token', { reason: 'no_token' }),
    );
    expect(sent).toEqual({
      status: 503,
      body: { error: { code: 'upstream_unavailable', message: 'The Lichess opening explorer needs a Lichess API token', details: { reason: 'no_token' } } },
    });
    expect(logs).toEqual([{ level: 'info', obj: { code: 'upstream_unavailable', reason: 'no_token' }, msg: expect.any(String) }]);
  });

  it('logs unreachable or failing upstreams as warnings without a stack', () => {
    const down = handle(upstreamHttpError(new UpstreamError('timeout', 'lichess.org', 'lichess.org timed out')) as Error);
    const bad = handle(upstreamHttpError(new UpstreamError('status', 'api.chess.com', 'api.chess.com answered 500', { status: 500 })) as Error);
    expect([down.sent.status, bad.sent.status]).toEqual([503, 502]);
    for (const { logs } of [down, bad]) {
      expect(logs).toHaveLength(1);
      expect(logs[0]!.level).toBe('warn');
      expect(logs[0]!.obj).not.toHaveProperty('err');
    }
  });

  it('logs other server errors with their stack', () => {
    const http = handle(new HttpError(500, 'internal', 'broken'));
    expect(http.logs).toEqual([{ level: 'error', obj: { err: expect.any(HttpError) }, msg: 'broken' }]);
    const plain = handle(new Error('boom'));
    expect(plain.logs[0]).toMatchObject({ level: 'error', obj: { err: expect.any(Error) } });
    expect(plain.sent).toEqual({ status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } });
  });

  it('does not log client errors', () => {
    expect(handle(new HttpError(404, 'not_found', 'Not found')).logs).toEqual([]);
  });
});
