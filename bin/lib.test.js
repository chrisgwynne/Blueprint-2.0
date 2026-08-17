import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { bunInstallInstructions, hasCommand, isNpxCachePath, repoRootFromBinScript } from './lib.js';

describe('hasCommand', () => {
  test('true when the platform lookup command exits 0', () => {
    const found = hasCommand('bun', { spawnSyncImpl: () => ({ status: 0 }) });
    expect(found).toBe(true);
  });

  test('false when the platform lookup command exits non-zero', () => {
    const found = hasCommand('bun', { spawnSyncImpl: () => ({ status: 1 }) });
    expect(found).toBe(false);
  });

  test('uses `where` on win32 and `which` elsewhere', () => {
    const calls = [];
    const spawnSyncImpl = (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; };

    hasCommand('bun', { platform: 'win32', spawnSyncImpl });
    hasCommand('bun', { platform: 'linux', spawnSyncImpl });
    hasCommand('bun', { platform: 'darwin', spawnSyncImpl });

    expect(calls).toEqual([
      ['where', ['bun']],
      ['which', ['bun']],
      ['which', ['bun']],
    ]);
  });
});

describe('bunInstallInstructions', () => {
  test('Windows gets the PowerShell irm command', () => {
    const { platformName, lines } = bunInstallInstructions('win32');
    expect(platformName).toBe('Windows');
    expect(lines.join('\n')).toContain('powershell -c "irm bun.sh/install.ps1 | iex"');
  });

  test('macOS gets the curl command and zsh reload hint', () => {
    const { platformName, lines } = bunInstallInstructions('darwin');
    expect(platformName).toBe('macOS');
    expect(lines.join('\n')).toContain('curl -fsSL https://bun.sh/install | bash');
    expect(lines.join('\n')).toContain('~/.zshrc');
  });

  test('Linux gets the curl command and bash reload hint', () => {
    const { platformName, lines } = bunInstallInstructions('linux');
    expect(platformName).toBe('Linux');
    expect(lines.join('\n')).toContain('curl -fsSL https://bun.sh/install | bash');
    expect(lines.join('\n')).toContain('~/.bashrc');
  });

  test('unknown platforms fall back to the Linux instructions', () => {
    const { platformName } = bunInstallInstructions('freebsd');
    expect(platformName).toBe('Linux');
  });

  test('defaults to process.platform when no argument is given', () => {
    const { platformName } = bunInstallInstructions();
    const expected = process.platform === 'win32' ? 'Windows'
      : process.platform === 'darwin' ? 'macOS'
      : 'Linux';
    expect(platformName).toBe(expected);
  });
});

describe('repoRootFromBinScript', () => {
  test('resolves the repo root one directory above a fabricated bin script, regardless of cwd', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const root = repoRootFromBinScript('file:///fake/project/bin/blueprint.js');
      expect(root).toBe('/fake/project');
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('resolves to this repo\'s real root when pointed at the real bin/blueprint.js, from any cwd', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const binScriptUrl = new URL('./blueprint.js', import.meta.url);
      const root = repoRootFromBinScript(binScriptUrl);

      expect(existsSync(join(root, 'scripts', 'setup.js'))).toBe(true);
      expect(existsSync(join(root, 'package.json'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('isNpxCachePath', () => {
  test('true for an npx cache-shaped path (posix)', () => {
    expect(isNpxCachePath('/home/user/.npm/_npx/abc123/node_modules/blueprint')).toBe(true);
  });

  test('true for an npx cache-shaped path (windows)', () => {
    expect(isNpxCachePath('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\blueprint')).toBe(true);
  });

  test('false for an ordinary clone path', () => {
    expect(isNpxCachePath('/home/user/projects/Blueprint-2.0')).toBe(false);
  });
});
