/**
 * Showing a tab's game (src/studio/board.ts): the cursor goes back to the tab's saved path, and after
 * lila reloaded its data the board always jumps, even to the root it already stands on, because only
 * a jump makes the opening explorer (and the rest of lila) follow the new position.
 */
import { describe, expect, it, vi } from 'vitest';
import { cursorPath, restoreCursor, type CursorHost } from '../src/studio/board.ts';

/** A stand-in for lila's AnalyseCtrl whose jump does what lila's does to the explorer. */
function host(paths: string[], lastPly = 4): CursorHost & { explorerFetches: number } {
  const h = {
    path: '',
    explorerFetches: 0,
    tree: { lastPly: () => lastPly, pathExists: (p: string) => p === '' || paths.includes(p) },
    mainlinePlyToPath: (ply: number) => 'ab'.repeat(ply),
    userJump: vi.fn((p: string) => {
      h.path = p;
      h.explorerFetches++; // lila: jump() → explorer.setNode() → fetch
    }),
  };
  return h;
}

describe('cursorPath', () => {
  it('reads null as the end of the mainline and a vanished path as the start', () => {
    const h = host(['ab', 'abab']);
    expect(cursorPath(h, null)).toBe('abababab');
    expect(cursorPath(h, 'abab')).toBe('abab');
    expect(cursorPath(h, 'zz')).toBe('');
    expect(cursorPath(h, '')).toBe('');
  });
});

describe('restoreCursor', () => {
  it('jumps to the root after a reload, so the explorer asks for the start position', () => {
    // a new board, a tab switched back to at its start, a My Files file opened at path ''
    const h = host([]);
    restoreCursor(h, '', true);
    expect(h.userJump).toHaveBeenCalledWith('');
    expect(h.explorerFetches).toBe(1);
  });

  it('jumps to a saved path after a reload', () => {
    const h = host(['ab', 'abab']);
    restoreCursor(h, 'abab', true);
    expect(h.userJump).toHaveBeenCalledWith('abab');
    restoreCursor(h, 'gone', true);
    expect(h.userJump).toHaveBeenLastCalledWith('');
  });

  it('at mount, jumps only when the saved path is elsewhere (lila already showed the root)', () => {
    const h = host(['ab']);
    restoreCursor(h, '', false);
    expect(h.userJump).not.toHaveBeenCalled();
    restoreCursor(h, 'ab', false);
    expect(h.userJump).toHaveBeenCalledWith('ab');
  });
});
