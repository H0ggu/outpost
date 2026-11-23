/**
 * A small in-memory LRU cache with a per-entry expiry. Bounded by entry count and, with `weigh`,
 * by total weight (e.g. rows held), so a few large entries can't take the memory of many small ones.
 */
export class Lru<V> {
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #weigh: (value: V) => number;
  readonly #maxWeight: number;
  #weight = 0;
  readonly #map = new Map<string, { value: V; expires: number; weight: number }>();

  constructor(opts: { max: number; ttlMs: number; now?: () => number; weigh?: (value: V) => number; maxWeight?: number }) {
    this.#max = opts.max;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
    this.#weigh = opts.weigh ?? (() => 1);
    this.#maxWeight = opts.maxWeight ?? Infinity;
  }

  get(key: string): V | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.#now()) {
      this.#delete(key);
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    this.#delete(key);
    const weight = Math.max(0, this.#weigh(value));
    if (weight > this.#maxWeight) return; // never fits
    this.#map.set(key, { value, expires: this.#now() + this.#ttlMs, weight });
    this.#weight += weight;
    while (this.#map.size > this.#max || this.#weight > this.#maxWeight) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
  }

  #delete(key: string): void {
    const e = this.#map.get(key);
    if (!e) return;
    this.#weight -= e.weight;
    this.#map.delete(key);
  }

  get size(): number {
    return this.#map.size;
  }

  /** Total weight held. */
  get weight(): number {
    return this.#weight;
  }

  clear(): void {
    this.#map.clear();
    this.#weight = 0;
  }
}
