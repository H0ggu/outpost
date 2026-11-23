/**
 * Runtime versions of lila's `$html` and `$trim` template tags (PLAN §8.2).
 *
 * lila's build tool rewrites `$html\`…\`` and `$trim\`…\`` at compile time
 * (ui/.build/src/esbuild.ts `condenseLiterals`); Vite doesn't, so the Studio installs these as globals.
 * They condense the literal parts the same way and leave interpolated values untouched.
 */

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => string;

const join = (strings: TemplateStringsArray, values: unknown[], condense: (s: string) => string): string => {
  let out = '';
  strings.forEach((raw, i) => {
    let s = condense(raw);
    if (i === 0) s = s.trimStart();
    if (i === strings.length - 1) s = s.trimEnd();
    out += s + (i < values.length ? String(values[i]) : '');
  });
  return out;
};

/** HTML: collapses whitespace runs to one space and removes whitespace between tags. */
export const html: Tag = (strings, ...values) =>
  join(strings, values, s => s.replace(/\s+/g, ' ').replace(/>\s+</g, '><'));

/** Text for `<pre>`: trims indentation, joins single newlines, keeps paragraph breaks. */
export const trim: Tag = (strings, ...values) =>
  join(strings, values, s => s.replace(/(?:\n[ \t]*){2,}/g, '\n\n').replace(/\n[ \t]+/g, ' '));
