/**
 * Pure DATABASE_PATH resolution helpers, split out from db.ts so the
 * resolution logic can be unit-tested without triggering db.ts's module-load
 * side effects (opening a real sqlite handle, running startup migrations).
 *
 * See: https://github.com/chrisgwynne/Blueprint-2.0/issues/41
 *
 * A configured non-memory DATABASE_PATH must resolve to the SAME absolute
 * path no matter what the process's current working directory happens to be
 * at invocation time. Resolving against `process.cwd()` (the previous
 * behaviour) meant the exact same inherited env value, e.g.
 * `DATABASE_PATH=./data/blueprint.db`, silently opened a DIFFERENT database
 * depending on whether a standalone Bun command was launched from the repo
 * root or from `server/` — a "shadow" database, usually empty, with no
 * warning. We instead resolve relative paths against a stable, well-defined
 * base directory supplied by the caller (db.ts passes the repo root),
 * matching the existing `PROJECT_ROOT = resolve(__dirname, '../..')`
 * convention already used by server/db/init.ts.
 */
import { resolve } from 'path';

/**
 * True for ':memory:' and bun:sqlite's other in-memory sentinels (e.g.
 * 'file::memory:?cache=shared'). These must be passed through to
 * `new Database()` verbatim — resolve()ing them turns the special string
 * into a literal relative-path file (e.g. "<cwd>/:memory:"), silently
 * defeating the "ephemeral, never touches disk" guarantee test-setup.ts
 * relies on.
 */
export function isMemoryDbPath(value: string | undefined): boolean {
  return (
    value === ':memory:' ||
    !!value?.startsWith('file::memory:') ||
    !!value?.startsWith(':memory:?')
  );
}

/**
 * Resolves a configured DATABASE_PATH env value to the absolute path that
 * should actually be opened, given a stable `baseDir` (NOT `process.cwd()`)
 * to resolve relative paths against.
 *
 * - unset/empty -> `<baseDir>/data/blueprint.db`
 * - an in-memory sentinel -> passed through unchanged
 * - absolute path -> passed through unchanged (path.resolve ignores baseDir
 *   when the second argument is already absolute)
 * - relative path -> resolved against `baseDir`, never against the
 *   process's current working directory
 */
export function resolveDbPath(envPath: string | undefined, baseDir: string): string {
  if (!envPath) return resolve(baseDir, 'data/blueprint.db');
  if (isMemoryDbPath(envPath)) return envPath;
  return resolve(baseDir, envPath);
}
