/**
 * Splits a PGN stream into the text of each game, at exactly the boundaries chessops' PgnParser
 * uses (a blank line after the movetext, outside `{…}` comments), so the importer can parse every
 * game on its own with `parsePgnGames(text)`.
 *
 * Why: one `parsePgnGames` over a whole stream stops for good at the first game that exceeds
 * chessops' complexity budget (`ERR_PGN_BUDGET`: the parser stays dead for the rest of the input),
 * which would abort a whole month or upload for one hostile or broken game. Split first, a game
 * that is too large is dropped without being buffered, and one that is too complex is skipped.
 *
 * The state machine mirrors chessops' (`pre` → `headers` → `moves` ⇄ `comment`): `%` escape lines,
 * a BOM, tag pairs (several per line), `;` rest-of-line comments and multi-line `{…}` comments.
 */

/** A game's text, or a game that was dropped because its text exceeded `maxGameChars`. */
export type SplitGame = { text: string } | { oversized: true; chars: number };

/** Longest game text passed to the parser: chessops' budget (1,000,000) is spent at ≥ 1 per character. */
export const MAX_GAME_CHARS = 1_000_000;

const TAG_RE = /^\s*\[([A-Za-z0-9][A-Za-z0-9_+#=:-]*)\s+"((?:[^"\\]|\\"|\\\\)*)"\]/;
const BOM = '﻿';
const isWhitespace = (s: string): boolean => /^\s*$/.test(s);

type State = 'bom' | 'pre' | 'headers' | 'moves' | 'comment';

/** Line-level splitter (exported for tests); feed lines, collect finished games. */
export class PgnSplitter {
  readonly #max: number;
  #state: State = 'bom';
  #lines: string[] = [];
  #chars = 0;
  #oversized = false;
  readonly #out: SplitGame[] = [];

  constructor(maxGameChars = MAX_GAME_CHARS) {
    this.#max = maxGameChars;
  }

  /** Games finished so far (the caller takes them). */
  take(): SplitGame[] {
    return this.#out.splice(0);
  }

  /**
   * One line without its newline (`\r` already removed). `fresh` is false for the continuation of
   * an over-long line fed in pieces.
   */
  line(raw: string, fresh = true): void {
    let line = raw;
    let freshLine = fresh;
    if (this.#state === 'bom') {
      if (line.startsWith(BOM)) line = line.slice(BOM.length);
      this.#state = 'pre';
    }
    if (this.#state === 'pre') {
      if (!fresh || isWhitespace(line) || line.startsWith('%')) return;
      this.#state = 'headers';
    }
    this.#keep(raw, fresh);
    for (;;) {
      switch (this.#state) {
        case 'headers': {
          if (freshLine && line.startsWith('%')) return;
          let m: RegExpExecArray | null;
          while ((m = TAG_RE.exec(line))) {
            line = line.slice(m[0].length);
            freshLine = false;
          }
          if (isWhitespace(line)) return;
          this.#state = 'moves';
          continue;
        }
        case 'moves': {
          if (freshLine) {
            if (line.startsWith('%')) return;
            if (isWhitespace(line)) {
              this.#end();
              return;
            }
          }
          const brace = line.indexOf('{');
          const semi = line.indexOf(';');
          if (semi !== -1 && (brace === -1 || semi < brace)) return;
          if (brace === -1) return;
          line = line.slice(brace + 1);
          this.#state = 'comment';
          freshLine = false;
          continue;
        }
        case 'comment': {
          const close = line.indexOf('}');
          if (close === -1) return;
          line = line.slice(close);
          this.#state = 'moves';
          freshLine = false;
          continue;
        }
        default:
          return;
      }
    }
  }

  /** End of input: the game in progress (if any) is complete. */
  end(): void {
    if (this.#state !== 'bom' && this.#state !== 'pre') this.#end();
  }

  #keep(raw: string, fresh: boolean): void {
    this.#chars += raw.length + (fresh ? 1 : 0);
    if (this.#oversized) return;
    if (this.#chars > this.#max) {
      this.#oversized = true;
      this.#lines = [];
      return;
    }
    if (fresh || this.#lines.length === 0) this.#lines.push(raw);
    else this.#lines[this.#lines.length - 1] += raw;
  }

  #end(): void {
    this.#out.push(this.#oversized ? { oversized: true, chars: this.#chars } : { text: this.#lines.join('\n') });
    this.#lines = [];
    this.#chars = 0;
    this.#oversized = false;
    this.#state = 'pre';
  }
}

/**
 * Streams the games of a PGN (strings or UTF-8 bytes) as separate texts. Memory stays bounded by
 * `maxGameChars` per game, even for a single line that never ends.
 */
export async function* splitPgnGames(
  input: AsyncIterable<string | Uint8Array>,
  opts: { maxGameChars?: number } = {},
): AsyncGenerator<SplitGame> {
  const max = opts.maxGameChars ?? MAX_GAME_CHARS;
  const splitter = new PgnSplitter(max);
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  // True while `carry` continues a line whose start was already fed (an over-long line).
  let continued = false;
  const feed = (text: string): void => {
    let data = carry + text;
    carry = '';
    let idx = 0;
    for (;;) {
      const nl = data.indexOf('\n', idx);
      if (nl === -1) break;
      const end = nl > idx && data[nl - 1] === '\r' ? nl - 1 : nl;
      splitter.line(data.slice(idx, end), !continued);
      continued = false;
      idx = nl + 1;
    }
    data = data.slice(idx);
    if (data.length > max) {
      // Feed the start of a line that will not fit anyway, keeping only a possible '\r'.
      const keep = data.endsWith('\r') ? 1 : 0;
      splitter.line(data.slice(0, data.length - keep), !continued);
      continued = true;
      carry = data.slice(data.length - keep);
    } else carry = data;
  };
  for await (const chunk of input) {
    feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    yield* splitter.take();
  }
  feed(decoder.decode());
  if (carry) splitter.line(carry, !continued);
  splitter.end();
  yield* splitter.take();
}
