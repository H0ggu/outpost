/**
 * My Files folder tree (PLAN §8.4). Folders are slash-separated paths stored on each file
 * (`files.folder`); `GET /api/folders` lists those in use, and a folder the user just created lives
 * only in this browser until a file is saved into it.
 */
import type { FolderInfo, StudioFileMeta } from '@outpost/shared/api';

/** One folder with its direct children. `path` is `''` for the root. */
export interface FolderNode {
  path: string;
  name: string;
  folders: FolderNode[];
  files: StudioFileMeta[];
  /** Files in this folder and below. */
  total: number;
}

const MAX_FOLDER_LENGTH = 200;

/**
 * Canonical folder path: trimmed segments, single slashes, no leading/trailing slash. Returns null
 * for paths that are too long or contain `.`/`..` segments or control characters.
 */
export function normalizeFolder(input: string): string | null {
  const segments = input
    .split('/')
    .map(s => s.trim())
    .filter(Boolean);
  if (segments.some(s => s === '.' || s === '..' || /[\u0000-\u001f\u007f\\]/.test(s))) return null;
  const path = segments.join('/');
  return path.length > MAX_FOLDER_LENGTH ? null : path;
}

/** `a/b/c` → `['a', 'a/b', 'a/b/c']`. */
export function folderAncestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/** Builds the tree from the file list, the server's folder list and locally created folders. */
export function buildFolderTree(
  files: readonly StudioFileMeta[],
  folders: readonly FolderInfo[] = [],
  localFolders: readonly string[] = [],
): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: [], files: [], total: 0 };
  const index = new Map<string, FolderNode>([['', root]]);
  const ensure = (path: string): FolderNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parent = ensure(slash === -1 ? '' : path.slice(0, slash));
    const node: FolderNode = { path, name: path.slice(slash + 1), folders: [], files: [], total: 0 };
    parent.folders.push(node);
    index.set(path, node);
    return node;
  };
  for (const f of folders) {
    const p = normalizeFolder(f.path);
    if (p !== null) ensure(p);
  }
  for (const p of localFolders) {
    const n = normalizeFolder(p);
    if (n !== null) ensure(n);
  }
  for (const file of files) {
    if (file.deletedAt !== null) continue;
    const folder = ensure(normalizeFolder(file.folder) ?? '');
    folder.files.push(file);
    for (const p of ['', ...folderAncestors(folder.path)]) {
      const n = index.get(p);
      if (n) n.total++;
    }
  }
  const sort = (n: FolderNode): void => {
    n.folders.sort(byName);
    n.files.sort(byName);
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every folder path in the tree, depth first (for "move to folder" pickers). */
export function allFolderPaths(node: FolderNode): string[] {
  return [node.path, ...node.folders.flatMap(allFolderPaths)];
}

/** Suggests a unique file name in a folder: `name`, `name (2)`, `name (3)`, … */
export function uniqueFileName(name: string, folder: string, files: readonly StudioFileMeta[]): string {
  const taken = new Set(
    files.filter(f => f.deletedAt === null && f.folder === folder).map(f => f.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
