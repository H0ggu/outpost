/**
 * Country flags as emoji (no image requests: COEP forbids cross-origin images, PLAN §8.5).
 * Codes are ISO 3166-1 alpha-2 (`XK` = Kosovo); the server already maps Lichess/Chess.com
 * special flags (GB-ENG, XE, …) to these.
 */

let regionNames: Intl.DisplayNames | null | undefined;

/** English country name for an alpha-2 code (falls back to the code). */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  const upper = code.toUpperCase();
  try {
    return regionNames?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** Regional-indicator emoji for an alpha-2 code, or null if it isn't one. */
export function flagEmoji(code: string): string | null {
  if (!/^[A-Za-z]{2}$/.test(code)) return null;
  const base = 0x1f1e6;
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => base + c.charCodeAt(0) - 65));
}

/** `<FlagEmoji code="NO" />` → 🇳🇴 with the country name as tooltip; renders nothing for unknown codes. */
export function FlagEmoji({ code, className }: { code: string | null | undefined; className?: string }) {
  const flag = code ? flagEmoji(code) : null;
  if (!code || !flag) return null;
  const name = countryName(code);
  return (
    <span className={['flag', className].filter(Boolean).join(' ')} title={name} role="img" aria-label={name}>
      {flag}
    </span>
  );
}
