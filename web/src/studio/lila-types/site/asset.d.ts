/** web/vendor/lila/site/src/asset.ts (subset). Studio wraps these in its site shim. */
export function baseUrl(): string;
export function flairSrc(flair: string): string;
export function fideFedSrc(fideFed: string): string;
export function releaseCss(loc: CssLocation): void;
export function removeCss(loc: CssLocation): void;
export function jsModule(name: string, prefix?: string): string;
/** Resolves once the piece images in body's `---white-pawn`… variables are decoded. */
export const loadPieces: Promise<void>;
