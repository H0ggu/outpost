/**
 * One save at a time per tab (src/studio/saveQueue.ts): Ctrl+S pressed twice must not send two PUTs
 * with the same base (the server would answer the second with a false 409 conflict).
 */
import { describe, expect, it, vi } from 'vitest';
import { SaveQueue } from '../src/studio/saveQueue.ts';

/** A save whose PUT is answered when the test says so; records the base each PUT carried. */
function fakeServer() {
  let updatedAt = 100;
  const bases: number[] = [];
  const pending: Array<() => void> = [];
  const put = (base: number) =>
    new Promise<number>((resolve, reject) => {
      bases.push(base);
      pending.push(() => {
        if (base < updatedAt) reject(new Error('409 conflict'));
        else resolve((updatedAt += 1));
      });
    });
  const answer = async () => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()!();
  };
  return { put, bases, answer };
}

describe('SaveQueue', () => {
  it('runs a second save after the first, with the base the first one returned', async () => {
    const server = fakeServer();
    let base = 100;
    let changed = false;
    const onChange = vi.fn();
    const q = new SaveQueue<string>(onChange);
    const save = async () => {
      try {
        base = await server.put(base);
        return true;
      } catch {
        return false;
      }
    };
    const first = q.run('t1', save, ok => ok && changed);
    expect(q.busy('t1')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    changed = true; // a move played while the first PUT is on its way
    const second = q.run('t1', save, ok => ok && changed);
    await server.answer();
    expect(await first).toBe(true);
    await server.answer();
    expect(await second).toBe(true);
    expect(server.bases).toEqual([100, 101]); // never the stale 100 twice
    expect(q.busy('t1')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2); // busy, then idle once both are done
  });

  it('shares the first result when nothing changed meanwhile', async () => {
    const server = fakeServer();
    const q = new SaveQueue<string>();
    const task = vi.fn(async () => {
      await server.put(100);
      return true;
    });
    const first = q.run('t1', task, ok => ok && false);
    const second = q.run('t1', task, ok => ok && false);
    const third = q.run('t1', task, ok => ok && false);
    await server.answer();
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(task).toHaveBeenCalledTimes(1);
    expect(server.bases).toEqual([100]);
  });

  it('does not retry after a failed or cancelled save, but an explicit Save as still runs', async () => {
    const q = new SaveQueue<string>();
    let release!: (ok: boolean) => void;
    const failing = vi.fn(() => new Promise<boolean>(r => (release = r)));
    const retry = vi.fn(async () => true);
    const first = q.run('t1', failing, ok => ok);
    const again = q.run('t1', retry, ok => ok); // Ctrl+S again while the conflict dialog is up
    const saveAs = q.run('t1', retry); // Save as… chosen meanwhile
    await vi.waitFor(() => expect(failing).toHaveBeenCalled());
    release(false);
    expect(await first).toBe(false);
    expect(await again).toBe(false);
    expect(await saveAs).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps tabs apart and turns a throwing task into a failed save', async () => {
    const q = new SaveQueue<string>();
    const a = q.run('a', async () => {
      throw new Error('boom');
    });
    expect(q.busy('a')).toBe(true);
    expect(q.busy('b')).toBe(false);
    const b = q.run('b', async () => true);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(q.busy('a')).toBe(false);
  });
});
