/**
 * Regression test for issue #41: invoking DB initialisation with the SAME
 * configured relative DATABASE_PATH from two different working directories
 * (repo root vs. server/) must select the SAME resolved absolute database
 * file. Before the fix, db.ts resolved a relative DATABASE_PATH against
 * process.cwd(), so the exact same env value silently opened a different
 * ("shadow") database depending on invocation directory.
 *
 * This spawns the real db.ts module (via the __print-db-path.ts helper) as
 * a genuine standalone Bun process from each directory, rather than
 * unit-testing the resolver in isolation — it proves the fix end-to-end,
 * exactly as issue #41's suggested safeguard describes.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '../..');
const PRINT_SCRIPT = resolve(__dirname, '__print-db-path.ts');

// A relative DATABASE_PATH pointed at a throwaway location, distinct from
// the real dev database, so this test never touches ./data/blueprint.db.
const RELATIVE_DB_PATH = '.tmp-issue41-db-path-test/probe.db';
const EXPECTED_ABS_PATH = resolve(REPO_ROOT, RELATIVE_DB_PATH);
const TMP_DIR = resolve(REPO_ROOT, '.tmp-issue41-db-path-test');

function runFromCwd(cwd: string): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', PRINT_SCRIPT],
    cwd,
    env: { ...process.env, DATABASE_PATH: RELATIVE_DB_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const match = stdout.match(/DB_PATH=(.+)/);
  if (!match) {
    throw new Error(
      `__print-db-path.ts (cwd=${cwd}) did not print DB_PATH.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return match[1]!.trim();
}

describe('DATABASE_PATH resolution is CWD-independent (issue #41)', () => {
  afterAll(() => {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  test(
    'the same relative DATABASE_PATH resolves to the same absolute path from the repo root and from server/',
    () => {
      const fromRepoRoot = runFromCwd(REPO_ROOT);
      const fromServerDir = runFromCwd(SERVER_DIR);

      expect(fromRepoRoot).toBe(EXPECTED_ABS_PATH);
      expect(fromServerDir).toBe(EXPECTED_ABS_PATH);
      expect(fromServerDir).toBe(fromRepoRoot);
    },
    30000,
  );
});
