/**
 * URLs accepted by `POST /api/admin/reference/import {url}`: https only, no credentials, public
 * hosts only (no localhost, private or link-local addresses written as IP literals or local names).
 * The route checks the URL as written; the job also resolves the host name and refuses it when any
 * address is non-public (`resolvedHostProblem`) before downloading.
 *
 * Limits (admin-only feature, so admin-trusted): the shared upstream client follows redirects
 * itself, so a redirect target is checked (scheme, host, resolved addresses) only once its answer
 * has arrived, and nothing is read from it when it fails; DNS answers can change between the check
 * and the request (rebinding). When the host cannot be resolved here (e.g. egress only through a
 * proxy) the check is left to the download itself.
 *
 * Lichess broadcast pages get special handling: a round page becomes a 'broadcastRound' job (official
 * API, token, round hints), a tour page imports the tour's PGN export.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { UPSTREAM } from '../http/upstream.ts';

/** Longest URL accepted. */
export const MAX_IMPORT_URL_LENGTH = 2048;

const PRIVATE_V4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_V4.addSubnet(net, bits, 'ipv4');
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/** True when a hostname (as in `URL.hostname`) is a loopback, private or otherwise non-public address. */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ip = isIP(host);
  if (ip === 4) return PRIVATE_V4.check(host, 'ipv4');
  if (ip === 6) {
    // Only global unicast (2000::/3) counts as public; this also refuses ::1, fc00::/7, fe80::/10,
    // multicast and IPv4-mapped forms of private addresses.
    return !/^[23][0-9a-f]{0,3}:/.test(host);
  }
  if (host === 'localhost' || !host.includes('.')) return true;
  return LOCAL_SUFFIXES.some(s => host.endsWith(s));
}

/** The resolver used by `resolvedHostProblem` (replaceable in tests, which have no network). */
export const IMPORT_DNS: { lookup: (hostname: string) => Promise<Array<{ address: string }>> } = {
  lookup: hostname => lookup(hostname, { all: true, verbatim: true }),
};

/**
 * Why a URL's host cannot be downloaded from after resolving it: a name whose addresses include a
 * loopback, private or otherwise non-public one. Null when every address is public, for IP
 * literals (`importUrlProblem` checks those) and when the name does not resolve here.
 */
export async function resolvedHostProblem(url: string | URL): Promise<string | null> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await IMPORT_DNS.lookup(host);
  } catch {
    return null;
  }
  const bad = addresses.find(a => isNonPublicHost(a.address));
  return bad ? `${host} resolves to a non-public address (${bad.address})` : null;
}

/** Why a URL cannot be imported, or null when it can. */
export function importUrlProblem(raw: string): string | null {
  if (raw.length > MAX_IMPORT_URL_LENGTH) return `The URL is longer than ${MAX_IMPORT_URL_LENGTH} characters`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (u.protocol !== 'https:') return 'Only https:// URLs can be imported';
  if (u.username || u.password) return 'URLs with credentials are not allowed';
  if (isNonPublicHost(u.hostname)) return `${u.hostname} is not a public host`;
  return null;
}

/** A Lichess broadcast page or export URL. */
export type LichessBroadcastUrl = { kind: 'round'; roundId: string } | { kind: 'tour'; tourId: string; pgnUrl: string };

/**
 * Recognises Lichess broadcast URLs: round pages (`/broadcast/<tour>/<round>/<roundId>[/<chapter>]`),
 * round exports (`/api/broadcast/round/<roundId>.pgn`) and tour pages (`/broadcast/<tour>/<tourId>`).
 */
export function lichessBroadcastUrl(raw: string): LichessBroadcastUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'lichess.org' && u.hostname !== 'www.lichess.org')) return null;
  const path = u.pathname.replace(/\/+$/, '');
  let m = /^\/broadcast\/[^/]+\/[^/]+\/([A-Za-z0-9]{8})(?:\/[A-Za-z0-9]{8})?$/.exec(path);
  if (m) return { kind: 'round', roundId: m[1]! };
  m = /^\/api\/broadcast\/round\/([A-Za-z0-9]{8})\.pgn$/.exec(path);
  if (m) return { kind: 'round', roundId: m[1]! };
  m = /^\/broadcast\/[^/]+\/([A-Za-z0-9]{8})$/.exec(path);
  if (m) return { kind: 'tour', tourId: m[1]!, pgnUrl: `${UPSTREAM.lichess}/api/broadcast/${m[1]}.pgn` };
  return null;
}
