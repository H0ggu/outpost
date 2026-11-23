/**
 * Node 26.11 renamed `DatabaseSync`/`StatementSync` to `Database`/`Statement` (the old names are
 * documentation-only deprecated aliases, DEP0210/DEP0211). @types/node 26.6.6 only declares the
 * old names, so declare the new ones as aliases. Delete this file once @types/node has them.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

declare module 'node:sqlite' {
  export const Database: typeof DatabaseSync;
  export type Database = DatabaseSync;
  export const Statement: typeof StatementSync;
  export type Statement = StatementSync;
}
