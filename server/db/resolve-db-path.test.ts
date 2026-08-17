/**
 * Regression tests for issue #41: a relative DATABASE_PATH must resolve to
 * the same absolute path regardless of the process's current working
 * directory at invocation time, and the in-memory sentinel pass-through
 * must keep working unchanged.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { isMemoryDbPath, resolveDbPath } from './resolve-db-path.js';

// Fake, non-existent-on-disk logical roots used purely as the `baseDir`
// argument to resolveDbPath — the function must never touch the
// filesystem, so these don't need to exist.
const REPO_ROOT = '/fake-repo-root';
const SERVER_DIR = '/fake-repo-root/server';

describe('isMemoryDbPath', () => {
  test('recognizes the plain :memory: sentinel', () => {
    expect(isMemoryDbPath(':memory:')).toBe(true);
  });

  test('recognizes file::memory: URIs', () => {
    expect(isMemoryDbPath('file::memory:?cache=shared')).toBe(true);
  });

  test('recognizes :memory:? query-suffixed sentinels', () => {
    expect(isMemoryDbPath(':memory:?cache=shared')).toBe(true);
  });

  test('rejects a real relative path', () => {
    expect(isMemoryDbPath('./data/blueprint.db')).toBe(false);
  });

  test('rejects a real absolute path', () => {
    expect(isMemoryDbPath('/var/data/blueprint.db')).toBe(false);
  });

  test('rejects undefined', () => {
    expect(isMemoryDbPath(undefined)).toBe(false);
  });
});

describe('resolveDbPath', () => {
  const originalCwd = process.cwd();
  // Two REAL, distinct, always-present directories to chdir between —
  // standing in for "invoked from the repo root" vs. "invoked from
  // server/". Their identity doesn't matter; what matters is that they are
  // different from each other and from `baseDir`, so any accidental
  // process.cwd()-based resolution would produce a different result.
  const cwdA = tmpdir();
  const cwdB = dirname(tmpdir());

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test(':memory: passes through verbatim, unresolved', () => {
    expect(resolveDbPath(':memory:', REPO_ROOT)).toBe(':memory:');
  });

  test('file::memory: URIs pass through verbatim, unresolved', () => {
    const sentinel = 'file::memory:?cache=shared';
    expect(resolveDbPath(sentinel, REPO_ROOT)).toBe(sentinel);
  });

  test('unset DATABASE_PATH falls back to <baseDir>/data/blueprint.db', () => {
    expect(resolveDbPath(undefined, REPO_ROOT)).toBe(resolve(REPO_ROOT, 'data/blueprint.db'));
  });

  test('an absolute DATABASE_PATH passes through regardless of baseDir', () => {
    expect(resolveDbPath('/mnt/ssd/blueprint.db', REPO_ROOT)).toBe('/mnt/ssd/blueprint.db');
    expect(resolveDbPath('/mnt/ssd/blueprint.db', SERVER_DIR)).toBe('/mnt/ssd/blueprint.db');
  });

  test('a relative DATABASE_PATH resolves against baseDir, not process.cwd()', () => {
    // Regression for #41: resolveDbPath must never consult process.cwd()
    // at all — changing the process's cwd must have zero effect on the
    // result as long as baseDir is held constant. Previously the
    // equivalent logic in db.ts resolved bare `resolve(_envPath)` (i.e.
    // against process.cwd()) and would have returned a DIFFERENT path
    // for the same env value here.
    const relative = './data/blueprint.db';
    const expected = resolve(REPO_ROOT, relative);

    process.chdir(cwdA);
    expect(resolveDbPath(relative, REPO_ROOT)).toBe(expected);

    process.chdir(cwdB);
    expect(resolveDbPath(relative, REPO_ROOT)).toBe(expected);
  });

  test('CWD-independence: repo-root-launch and server-dir-launch resolve identically', () => {
    // Directly models the two invocation locations called out in issue #41
    // (repo root vs. server/) by holding the configured relative
    // DATABASE_PATH and the resolved baseDir constant while varying only
    // process.cwd() — the resolved path must be identical in both cases,
    // proving the same database is opened no matter where the process was
    // launched from.
    const relativeEnvValue = './data/blueprint.db';

    process.chdir(cwdA); // stand-in for "launched from the repo root"
    const fromRepoRootCwd = resolveDbPath(relativeEnvValue, REPO_ROOT);

    process.chdir(cwdB); // stand-in for "launched from server/"
    const fromServerDirCwd = resolveDbPath(relativeEnvValue, REPO_ROOT);

    expect(fromServerDirCwd).toBe(fromRepoRootCwd);
    expect(fromRepoRootCwd).toBe(resolve(REPO_ROOT, relativeEnvValue));
  });
});
