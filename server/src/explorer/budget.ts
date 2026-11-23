/**
 * Request budgets for upstream services that limit requests per minute (PLAN §6: the Lichess
 * explorer allows 20 requests per minute). A sliding window of grant times plus a FIFO queue:
 * a request waits for the next free slot, in arrival order, up to `maxWaitMs`; a request whose
 * client went away (its signal aborted) leaves the queue at once, so lila's habit of abandoning
 * the previous position's fetch never wastes a slot.
 */

/** Why a request did not get a slot. */
export type BudgetFailure = 'queue_full' | 'queue_timeout' | 'aborted';

/** No slot for this request. */
export class BudgetError extends Error {
  override name = 'BudgetError';
  readonly reason: BudgetFailure;
  /** Earliest time a new request could get a slot (epoch ms). */
  readonly retryAt: number;

  constructor(reason: BudgetFailure, message: string, retryAt: number) {
    super(message);
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/** Options of a `RequestBudget`. */
export interface BudgetOptions {
  /** Requests allowed per window. */
  perWindow: number;
  windowMs: number;
  /** Longest queue; further requests fail at once with `queue_full`. */
  maxQueue: number;
  /** Longest wait in the queue before `queue_timeout`. */
  maxWaitMs: number;
  /** Clock and timers (tests inject fakes). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timeout: unknown;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

/** A sliding-window request budget with a FIFO queue. */
export class RequestBudget {
  readonly perWindow: number;
  readonly windowMs: number;
  readonly #maxQueue: number;
  readonly #maxWaitMs: number;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  /** Grant times inside the current window, oldest first. */
  #grants: number[] = [];
  #queue: Waiter[] = [];
  #timer: unknown = null;

  constructor(opts: BudgetOptions) {
    if (opts.perWindow < 1) throw new Error('perWindow must be ≥ 1');
    this.perWindow = opts.perWindow;
    this.windowMs = opts.windowMs;
    this.#maxQueue = opts.maxQueue;
    this.#maxWaitMs = opts.maxWaitMs;
    this.#now = opts.now ?? Date.now;
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.#queue.length;
  }

  /** Slots used in the current window. */
  get used(): number {
    this.#prune();
    return this.#grants.length;
  }

  /** When the next slot frees up (now if one is free). */
  nextSlotAt(): number {
    this.#prune();
    if (this.#grants.length < this.perWindow) return this.#now();
    return this.#grants[this.#grants.length - this.perWindow]! + this.windowMs;
  }

  /** Waits for a slot (FIFO). Rejects with `BudgetError` when the queue is full, the wait times out or `signal` aborts. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new BudgetError('aborted', 'Request cancelled', this.nextSlotAt()));
    this.#prune();
    if (this.#queue.length === 0 && this.#grants.length < this.perWindow) {
      this.#grants.push(this.#now());
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new BudgetError('queue_full', 'Too many upstream requests are waiting', this.nextSlotAt()));
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        signal,
        timeout: null,
        onAbort: () => {
          this.#remove(w);
          reject(new BudgetError('aborted', 'Request cancelled', this.nextSlotAt()));
        },
      };
      w.timeout = this.#setTimer(() => {
        this.#remove(w);
        reject(new BudgetError('queue_timeout', `No upstream request slot within ${Math.round(this.#maxWaitMs / 1000)} s`, this.nextSlotAt()));
      }, this.#maxWaitMs);
      signal?.addEventListener('abort', w.onAbort, { once: true });
      this.#queue.push(w);
      this.#schedule();
    });
  }

  #prune(): void {
    const cutoff = this.#now() - this.windowMs;
    let i = 0;
    while (i < this.#grants.length && this.#grants[i]! <= cutoff) i++;
    if (i) this.#grants.splice(0, i);
  }

  #remove(w: Waiter): void {
    const i = this.#queue.indexOf(w);
    if (i >= 0) this.#queue.splice(i, 1);
    this.#clearTimer(w.timeout);
    w.signal?.removeEventListener('abort', w.onAbort);
    if (this.#queue.length === 0 && this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  #schedule(): void {
    if (this.#timer !== null || this.#queue.length === 0) return;
    this.#prune();
    if (this.#grants.length < this.perWindow) {
      this.#drain();
      return;
    }
    const wait = Math.max(0, this.#grants[0]! + this.windowMs - this.#now());
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#drain();
    }, wait + 1);
  }

  #drain(): void {
    this.#prune();
    while (this.#queue.length && this.#grants.length < this.perWindow) {
      const w = this.#queue.shift()!;
      this.#clearTimer(w.timeout);
      w.signal?.removeEventListener('abort', w.onAbort);
      this.#grants.push(this.#now());
      w.resolve();
    }
    this.#schedule();
  }
}

/**
 * Per-client sliding windows (e.g. a client's share of an upstream budget): `take(key)` grants at
 * most `perWindow` per `windowMs` for each key. Memory stays bounded: at most `maxKeys` keys are
 * tracked, the least recently granted one is dropped first.
 */
export class ClientWindow {
  readonly perWindow: number;
  readonly windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #grants = new Map<string, number[]>();

  constructor(opts: { perWindow: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    if (opts.perWindow < 1) throw new Error('perWindow must be ≥ 1');
    this.perWindow = opts.perWindow;
    this.windowMs = opts.windowMs;
    this.#now = opts.now ?? Date.now;
    this.#maxKeys = opts.maxKeys ?? 10_000;
  }

  #live(key: string): number[] {
    const list = this.#grants.get(key) ?? [];
    const cutoff = this.#now() - this.windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    if (i) list.splice(0, i);
    return list;
  }

  /** Grants one request to `key` if its window has room. */
  take(key: string): boolean {
    const list = this.#live(key);
    if (list.length >= this.perWindow) return false;
    list.push(this.#now());
    this.#grants.delete(key); // re-insert: Map order = least recently granted first
    this.#grants.set(key, list);
    if (this.#grants.size > this.#maxKeys) {
      for (const k of this.#grants.keys()) {
        if (this.#grants.size <= this.#maxKeys) break;
        if (k !== key) this.#grants.delete(k);
      }
    }
    return true;
  }

  /** When `key` may take again (now if it has room). */
  nextSlotAt(key: string): number {
    const list = this.#live(key);
    if (list.length < this.perWindow) return this.#now();
    return list[list.length - this.perWindow]! + this.windowMs;
  }

  /** Keys tracked (tests). */
  get size(): number {
    return this.#grants.size;
  }
}

/**
 * A client's key for per-address limits: the IPv4 address, or the /64 prefix of an IPv6 one (a
 * single host usually controls a whole /64).
 */
export function clientKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map(g => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
