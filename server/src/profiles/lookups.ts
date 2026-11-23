/**
 * User-triggered account lookups on Lichess and Chess.com: the unified search's autocomplete and
 * exact-username check (src/search), and the account checks of a new profile source
 * (profiles/sources.ts). They share the upstreams with syncs and the explorers (one per-host 429
 * cool-down, http/upstream.ts), so a burst of searches or profile creations must never get the
 * instance throttled by lichess.org:
 * - an instance-wide budget per site (`LOOKUPS_PER_MIN`) and a per-client share of it
 *   (`LOOKUPS_PER_CLIENT_PER_MIN`, a signed-in user or an address);
 * - accounts found not to exist are remembered for `MISSING_ACCOUNT_TTL_MS`, so asking again
 *   costs nothing.
 * One instance per `Upstream` (`accountLookups(app.upstream)`), shared by every route of the app.
 */
import { ClientWindow } from '../explorer/budget.ts';
import type { Upstream } from '../http/upstream.ts';

/** Sites with user-triggered lookups. */
export type LookupSite = 'lichess' | 'chesscom';

/** Lookups per minute for the whole instance, per site. */
export const LOOKUPS_PER_MIN: Readonly<Record<LookupSite, number>> = { lichess: 60, chesscom: 60 };
/** Lookups per minute one client may start, per site. */
export const LOOKUPS_PER_CLIENT_PER_MIN = 30;
/** How long an account found not to exist is remembered. */
export const MISSING_ACCOUNT_TTL_MS = 10 * 60_000;
const MAX_MISSING = 5000;

/** The lookup budgets and the missing-account memory of one app. */
export class AccountLookups {
  readonly #now: () => number;
  readonly #perMin: Record<LookupSite, number>;
  /** Start times of the instance's lookups in the last minute, per site. */
  readonly #recent = new Map<LookupSite, number[]>();
  readonly #clients = new Map<LookupSite, ClientWindow>();
  readonly #missing = new Map<string, number>();

  constructor(opts: { now?: () => number; perMin?: Partial<Record<LookupSite, number>>; perClient?: number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#perMin = { ...LOOKUPS_PER_MIN, ...opts.perMin };
    for (const site of ['lichess', 'chesscom'] as const) {
      this.#clients.set(site, new ClientWindow({ perWindow: opts.perClient ?? LOOKUPS_PER_CLIENT_PER_MIN, windowMs: 60_000, now: this.#now }));
    }
  }

  /** Takes one lookup on `site` for `client`; false when the client's share or the instance budget is spent. */
  take(site: LookupSite, client: string): boolean {
    const now = this.#now();
    const recent = (this.#recent.get(site) ?? []).filter(t => t > now - 60_000);
    this.#recent.set(site, recent);
    if (recent.length >= this.#perMin[site]) return false;
    if (!this.#clients.get(site)!.take(client)) return false;
    recent.push(now);
    return true;
  }

  /** True while `key` is remembered as not existing on `site`. */
  isMissing(site: LookupSite, key: string): boolean {
    const k = `${site}:${key}`;
    const until = this.#missing.get(k);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#missing.delete(k);
    return false;
  }

  /** Remembers that `key` does not exist on `site`. */
  markMissing(site: LookupSite, key: string): void {
    const k = `${site}:${key}`;
    this.#missing.delete(k);
    this.#missing.set(k, this.#now() + MISSING_ACCOUNT_TTL_MS);
    while (this.#missing.size > MAX_MISSING) {
      const oldest = this.#missing.keys().next().value;
      if (oldest === undefined) break;
      this.#missing.delete(oldest);
    }
  }
}

const byUpstream = new WeakMap<Upstream, AccountLookups>();

/** The app's lookup budgets (one per `Upstream`, i.e. per app). */
export function accountLookups(upstream: Upstream): AccountLookups {
  let l = byUpstream.get(upstream);
  if (!l) {
    l = new AccountLookups();
    byUpstream.set(upstream, l);
  }
  return l;
}
