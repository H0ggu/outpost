/**
 * The Studio's stand-ins for lila's server: the socket shim (evalGet → /api/cloud-eval → evalHit),
 * asset URL mapping, and the runtime `$html`/`$trim` template tags.
 */
import { describe, expect, it, vi } from 'vitest';
import { lilaAssetUrl, SHIPPED_SOUNDS } from '../src/studio/assetUrl.ts';
import { makeSocketSend } from '../src/studio/socket.ts';
import { html, trim } from '../src/studio/templates.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const flush = () => new Promise(r => setTimeout(r, 0));

describe('socket shim', () => {
  const hit = { fen: FEN, knodes: 100, depth: 30, pvs: [{ moves: 'e7e5 g1f3', cp: 20 }] };
  const ok = (body: unknown, status = 200) => async (_input: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('answers evalGet with evalHit for the requested path', async () => {
    const receive = vi.fn();
    const fetchMock = vi.fn(ok(hit));
    const send = makeSocketSend(() => receive, () => true, fetchMock as unknown as typeof fetch);
    send('evalGet', { fen: FEN, path: 'aa', mpv: 3 });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://x');
    expect(url.pathname).toBe('/api/cloud-eval');
    expect(url.searchParams.get('fen')).toBe(FEN);
    expect(url.searchParams.get('multiPv')).toBe('3');
    expect(receive).toHaveBeenCalledWith('evalHit', { ...hit, path: 'aa' });
  });

  it('clamps multi-PV, de-duplicates in-flight requests and drops misses', async () => {
    const receive = vi.fn();
    const fetchMock = vi.fn(ok({ error: { code: 'not_found', message: 'none' } }, 404));
    const send = makeSocketSend(() => receive, () => true, fetchMock as unknown as typeof fetch);
    send('evalGet', { fen: FEN, path: '', mpv: 50 });
    send('evalGet', { fen: FEN, path: '', mpv: 50 });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(String(fetchMock.mock.calls[0]![0]), 'http://x').searchParams.get('multiPv')).toBe('5');
    expect(receive).not.toHaveBeenCalled();
  });

  it('ignores other messages, variants, malformed data and viewers without access', async () => {
    const fetchMock = vi.fn(ok(hit));
    let allowed = false;
    const send = makeSocketSend(() => vi.fn(), () => allowed, fetchMock as unknown as typeof fetch);
    send('evalGet', { fen: FEN, path: '' });
    allowed = true;
    send('evalPut', { fen: FEN });
    send('startWatching', 'abc');
    send('anaMove', {});
    send('evalGet', { fen: FEN, path: '', variant: 'atomic' });
    send('evalGet', undefined);
    send('evalGet', { fen: 3, path: '' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives network errors and empty answers', async () => {
    const receive = vi.fn();
    const failing = vi.fn(async (_input: string) => {
      throw new TypeError('offline');
    });
    makeSocketSend(() => receive, () => true, failing as unknown as typeof fetch)('evalGet', { fen: FEN, path: '' });
    const empty = vi.fn(ok({ ...hit, pvs: [] }));
    makeSocketSend(() => receive, () => true, empty as unknown as typeof fetch)('evalGet', { fen: FEN, path: '' });
    await flush();
    await flush();
    expect(receive).not.toHaveBeenCalled();
  });
});

describe('lila asset URLs', () => {
  const engines = { stockfishWeb: '/assets/vendor/stockfish-web-0.6.1', stockfishJs: '/assets/vendor/stockfish.js-10.0.2' };

  it('maps shipped assets to Outpost paths', () => {
    expect(lilaAssetUrl('sound/sfx/Move.mp3', engines)).toBe('/lichess/sound/sfx/Move.mp3');
    expect(lilaAssetUrl('/piece/merida/wN.svg', engines)).toBe('/lichess/piece/merida/wN.svg');
    expect(lilaAssetUrl('font/lichess.woff2', engines)).toBe('/lichess/font/lichess.woff2');
    expect(lilaAssetUrl('images/board/brown.png', engines)).toBe('/lichess/board/brown.png');
    expect(lilaAssetUrl('lifat/nnue/nn-61e7af4bb97d.nnue', engines)).toBe('/assets/lifat/nnue/nn-61e7af4bb97d.nnue');
    expect(lilaAssetUrl('npm/stockfish-web/sf_19_smallnet.js', engines)).toBe('/assets/vendor/stockfish-web-0.6.1/sf_19_smallnet.js');
    expect(lilaAssetUrl('npm/stockfish.js/stockfish.wasm.js?v=1', engines)).toBe('/assets/vendor/stockfish.js-10.0.2/stockfish.wasm.js');
  });

  it('answers "" for what Outpost does not ship or for odd paths', () => {
    for (const p of [
      'video/help.webm',
      'images/help/x.webp',
      'flair/img/x.webp',
      'fide/fed-webp/NOR.webp',
      'lifat/nnue/../../etc/passwd',
      'lifat/nnue/nn-zzzz.nnue',
      'npm/stockfish-nnue.wasm/stockfish.js',
      'npm/stockfish-web/a/b.js',
      'sound/../x.mp3',
      'sound/sfx/a/b.mp3',
      '',
    ])
      expect(lilaAssetUrl(p, engines), p).toBe('');
  });

  it('lists the vendored sound names', () => {
    expect([...SHIPPED_SOUNDS].sort()).toEqual(['capture', 'check', 'checkmate', 'genericNotify', 'move']);
  });
});

describe('$html / $trim', () => {
  it('condenses literal whitespace like lila’s build, keeping values', () => {
    const name = 'a  b';
    expect(html`
      <div class="x">
        <span>${name}</span>
      </div>
    `).toBe('<div class="x"><span>a  b</span></div>');
    expect(trim`
      first line
      continues

      new paragraph ${1 + 1}
    `).toBe('first line continues\n\nnew paragraph 2');
  });
});
