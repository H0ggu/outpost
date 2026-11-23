/** A small in-memory LRU cache with a per-entry expiry. */
export class Lru<V> {
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #map = new Map<string, { value: V; expires: number }>();

  constructor(opts: { max: number; ttlMs: number; now?: () => number }) {
    this.#max = opts.max;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const e = this.#map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.#now()) {
      this.#map.delete(key);
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, { value, expires: this.#now() + this.#ttlMs });
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  get size(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }
}
