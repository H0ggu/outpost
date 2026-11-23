/** web/vendor/lila/analyse/src/pgnImport.ts, with scripts/lila-patches/003 (annotations). */
import type { AnalyseData, Glyph } from './interfaces';

/** PGN (first game) → analysis data, keeping comments, NAGs, shapes, clocks and evals. Throws on bad PGN. */
export default function pgnImport(pgn: string): Partial<AnalyseData>;

/** lila's glyphs: NAG id, symbol and the `i18n.study` key of its name. */
export const pgnGlyphs: ReadonlyArray<[number, string, keyof I18n['study']]>;

/** Glyph for a NAG, if lila knows it. */
export function glyphOfNag(nag: number): Glyph | undefined;

/** Id of the comment that holds a move's PGN text. */
export const pgnCommentId: string;
