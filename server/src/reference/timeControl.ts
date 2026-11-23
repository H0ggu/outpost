/**
 * Time controls of over-the-board games as Lichess broadcasts write them.
 *
 * Broadcast PGNs copy the organiser's TimeControl tag, which is rarely the PGN standard (seconds):
 * `90+30` and `3+2` are minutes + seconds, `5400+30` is seconds, and free text such as
 * `G: 15 minutes + 5 seconds increment from move 1` or `90 min / 40 moves + 30 min + 30 sec` is
 * common. Games are classified with the FIDE rule (Laws of Chess, appendices A and B): the time for
 * 60 moves (base + 60 × increment) of at most 10 minutes is blitz, under 60 minutes rapid, else
 * standard (`classical`); under 3 minutes counts as bullet.
 */
import type { TimeClass } from '@outpost/shared/chess';
import { pgnTimeClass } from '../chess/index.ts';

/** A parsed clock in seconds. */
export interface OtbClock {
  initial: number;
  increment: number;
}

/** Bare numbers below this are minutes (`90+30`), from here on seconds (`5400+30`, `180+2`). */
const MINUTES_BELOW = 180;

const HOURS_RE = /(\d{1,2})\s*(?:h|hours?|hrs?)\b/;
const MINUTES_RE = /(\d{1,3})\s*(?:min(?:ute)?s?\b|mins?\.|m\b|'|’|′)/;
const GAME_IN_RE = /\bg\s*[/:]\s*(\d{1,3})\b/;
const SECONDS_RE = /(\d{1,3})\s*(?:sec(?:ond)?s?\b|secs?\.|s\b|"|″)/;
const PLUS_SECONDS_RE = /\+\s*(\d{1,3})(?!\s*(?:min|mins?\b|m\b|'|’|′|\/|\d))/;

/**
 * Parses a broadcast TimeControl tag into the first period's clock (seconds), or null when it says
 * nothing usable. PGN multi-period forms (`40/5400+30:1800+30`) are read as the PGN standard.
 */
export function parseOtbTimeControl(tc: string | null | undefined): OtbClock | null {
  const s = tc?.trim();
  if (!s) return null;
  const multi = /^\d+\/(\d+)(?:\+(\d+))?(?::|$)/.exec(s);
  if (multi) return { initial: Number(multi[1]), increment: Number(multi[2] ?? 0) };
  const bare = /^(\d{1,5})(?:\s*[+|]\s*(\d{1,3}))?$/.exec(s);
  if (bare) {
    const x = Number(bare[1]);
    if (x === 0 && !bare[2]) return null;
    return { initial: x < MINUTES_BELOW ? x * 60 : x, increment: Number(bare[2] ?? 0) };
  }
  const t = s.toLowerCase();
  const min = MINUTES_RE.exec(t) ?? GAME_IN_RE.exec(t);
  const hours = min ? null : HOURS_RE.exec(t);
  const base = min ?? hours;
  if (!base) return null;
  const rest = t.slice(base.index + base[0].length);
  const sec = SECONDS_RE.exec(rest) ?? PLUS_SECONDS_RE.exec(rest);
  return { initial: Number(base[1]) * (min ? 60 : 3600), increment: sec ? Number(sec[1]) : 0 };
}

/** FIDE classification of a clock (see the file comment). */
export function otbTimeClass(clock: OtbClock): TimeClass {
  const t = clock.initial + 60 * clock.increment;
  if (t <= 0) return 'unknown';
  if (t < 180) return 'bullet';
  if (t <= 600) return 'blitz';
  if (t < 3600) return 'rapid';
  return 'classical';
}

const CLASS_WORDS: ReadonlyArray<readonly [TimeClass, RegExp]> = [
  ['bullet', /\bbullet\b/i],
  ['blitz', /\bblitz\b/i],
  ['rapid', /(?:^|[^\p{L}])(?:rapid|rapide|rápido|rapido|schnellschach)(?![\p{L}])/iu],
  ['classical', /\b(?:classical|standard)\b/i],
];

/** Time class named by exactly one kind of word in free text (`Rapid`, `Blitz`, `Standard`…), or null. */
export function timeClassFromWords(text: string | null | undefined): TimeClass | null {
  if (!text) return null;
  const found = CLASS_WORDS.filter(([, re]) => re.test(text)).map(([c]) => c);
  return found.length === 1 ? found[0]! : null;
}

/** FIDE time-control names as Lichess broadcasts tag tours (`tour.info.fideTC`). */
export function timeClassFromFideTc(fideTC: string | null | undefined): TimeClass | null {
  switch (fideTC) {
    case 'standard':
      return 'classical';
    case 'rapid':
      return 'rapid';
    case 'blitz':
      return 'blitz';
    default:
      return null;
  }
}

/**
 * Time class and stored TimeControl (PGN seconds form `5400+30`, or the multi-period tag as written)
 * of an over-the-board game. Hints are tried in order when the tag says nothing usable: the tour's
 * FIDE time control, then words in the tag and the event names.
 */
export function otbTimeControl(
  tc: string | null | undefined,
  hints: { fideTC?: string | null; names?: ReadonlyArray<string | null | undefined> } = {},
): { timeClass: TimeClass; timeControl: string | null } {
  const raw = tc?.trim() || null;
  if (raw && /^\d+\/\d+/.test(raw)) {
    const tcClass = pgnTimeClass(raw);
    if (tcClass !== 'unknown') return { timeClass: tcClass, timeControl: raw };
  }
  const clock = parseOtbTimeControl(raw);
  if (clock) {
    const timeClass = otbTimeClass(clock);
    if (timeClass !== 'unknown') return { timeClass, timeControl: `${clock.initial}+${clock.increment}` };
  }
  const hinted =
    timeClassFromWords(raw) ?? timeClassFromFideTc(hints.fideTC) ?? (hints.names ?? []).map(timeClassFromWords).find(c => c !== null) ?? null;
  return { timeClass: hinted ?? 'unknown', timeControl: null };
}
