/**
 * The Studio embed (?embed=explorer, the profile Explorer tab's iframe) in studio.css: the explorer
 * gets the tools box (review finding ui-10) and lila's FEN and PGN boxes stay (features-10).
 * Layout itself was measured in Chromium; this guards the rules that make it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

let css = '';
beforeAll(async () => {
  // vitest's `css: false` empties `?raw` CSS imports; not `new URL(…, import.meta.url)` either,
  // which Vite rewrites into an asset URL.
  const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as {
    readFileSync: (path: string, encoding: 'utf8') => string;
  };
  const web = `${decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/\/[^/]*$/, ''))}/..`;
  css = fs.readFileSync(`${web}/src/studio/studio.css`, 'utf8');
});

/** Every rule (selector list → declarations), media queries flattened. */
function rules(text: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.trim().split(',').map(s => s.trim()).filter(Boolean);
    out.push({ selectors, body: m[2]! });
  }
  return out;
}

describe('Studio embed', () => {
  it('keeps lila’s FEN and PGN boxes (the underboard) in the embed', () => {
    const hidden = rules(css).filter(r => /display:\s*none/.test(r.body)).flatMap(r => r.selectors);
    expect(hidden).toContain('body.studio-embed #top');
    expect(hidden).toContain('body.studio-embed #studio-bar');
    expect(hidden).not.toContain('body.studio-embed .analyse__underboard');
  });

  it('gives the explorer the tools box, the move list only what its moves need', () => {
    const all = rules(css);
    const moves = all.find(r => r.selectors.includes('body.studio-embed .analyse__tools .analyse__moves'));
    expect(moves?.body).toMatch(/flex:\s*0 1 auto/);
    expect(moves?.body).toMatch(/max-height:/);
    const explorer = all.find(r => r.selectors.includes('body.studio-embed .analyse__tools .explorer-box.reduced'));
    expect(explorer?.body).toMatch(/flex:\s*1 1 0/);
  });
});
