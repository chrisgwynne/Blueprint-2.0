/**
 * Regression tests for the KB path-containment fix (F-02).
 *
 * Reproduces the exact exploit verified live during the audit: a caller-
 * supplied `../../` path escaping the KB root entirely, plus symlink-based
 * escapes (a symlink planted inside the KB root pointing outside it, as
 * could happen with an imported/synced Obsidian vault).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KBEngine, KBPathError, containPath } from './kb-engine.ts';

let root: string;
let outside: string;
let engine: KBEngine;

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'bp-kb-test-'));
  root = join(base, 'kb-root');
  outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  engine = new KBEngine(root, 'test-biz', 'biz_test');
  await engine.init('Test Biz');
});

afterEach(() => {
  try { rmSync(join(root, '..'), { recursive: true, force: true }); } catch {}
});

describe('containPath', () => {
  test('rejects ../ traversal', () => {
    expect(() => containPath(root, '../../../../etc/passwd')).toThrow(KBPathError);
  });

  test('rejects a traversal path that reaches outside the root but stays relative', () => {
    expect(() => containPath(root, '../outside/evil.md')).toThrow(KBPathError);
  });

  test('rejects absolute paths', () => {
    expect(() => containPath(root, '/etc/passwd')).toThrow(KBPathError);
  });

  test('rejects null bytes', () => {
    expect(() => containPath(root, 'wiki/evil.md\0.txt')).toThrow(KBPathError);
  });

  test('rejects reserved Windows device names', () => {
    expect(() => containPath(root, 'wiki/CON.md')).toThrow(KBPathError);
    expect(() => containPath(root, 'NUL.md')).toThrow(KBPathError);
  });

  test('allows a normal in-root path', () => {
    expect(() => containPath(root, 'wiki/normal-page.md')).not.toThrow();
  });

  test('rejects a symlink planted inside the root that points outside it', () => {
    const linkDir = join(root, 'evil-link');
    symlinkSync(outside, linkDir);
    expect(() => containPath(root, 'evil-link/passwd.md')).toThrow(KBPathError);
  });

  test('rejects reading through an existing symlinked file that points outside root', () => {
    const externalFile = join(outside, 'secret.md');
    writeFileSync(externalFile, 'top secret');
    const linkPath = join(root, 'looks-safe.md');
    symlinkSync(externalFile, linkPath);
    expect(() => containPath(root, 'looks-safe.md')).toThrow(KBPathError);
  });
});

describe('KBEngine.writeFile — path traversal blocked end-to-end', () => {
  test('reproduces the audit PoC: ../../../../ write is rejected, not executed', async () => {
    const target = join(outside, 'blueprint-audit-poc.md');
    await expect(
      engine.writeFile('../../../../' + target.replace(/^\//, ''), '# pwned', null, 'test')
    ).rejects.toThrow(KBPathError);
    expect(existsSync(target)).toBe(false);
  });

  test('a well-behaved in-root write still works', async () => {
    const result = await engine.writeFile('wiki/legit-page.md', '# Legit content', { title: 'Legit' }, 'test');
    expect(result.committed).toBe(true);
    expect(existsSync(join(root, 'wiki/legit-page.md'))).toBe(true);
  });

  test('cannot write through a pre-planted symlink to escape the root', async () => {
    const linkDir = join(root, 'escape');
    symlinkSync(outside, linkDir);
    await expect(engine.writeFile('escape/pwned.md', '# pwned', null, 'test')).rejects.toThrow(KBPathError);
    expect(existsSync(join(outside, 'pwned.md'))).toBe(false);
  });
});

describe('KBEngine.readFile — path traversal blocked end-to-end', () => {
  test('cannot read an arbitrary file outside the KB root via traversal', async () => {
    const secretFile = join(outside, 'secret.md');
    writeFileSync(secretFile, 'top secret contents');
    const relTraversal = '../' + secretFile.split('/').slice(-2).join('/');
    await expect(engine.readFile(relTraversal)).rejects.toThrow();
  });
});
