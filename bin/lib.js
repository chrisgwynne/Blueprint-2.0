/**
 * Pure, Node-compatible helpers for bin/blueprint.js.
 *
 * Kept dependency-free (built-ins only) and side-effect-free where possible
 * so it can run under plain Node — npx invokes bin/blueprint.js via Node,
 * before Bun is confirmed to exist — and so the interesting logic is
 * unit-testable without spawning real processes or touching the real cwd.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function hasCommand(cmd, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const which = platform === 'win32' ? 'where' : 'which';
  const r = spawnSyncImpl(which, [cmd], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

/**
 * Mirrors the exact commands documented in README.md's Installation section
 * for Windows/macOS/Linux — keep these two sources in sync by hand.
 */
export function bunInstallInstructions(platform = process.platform) {
  if (platform === 'win32') {
    return {
      platformName: 'Windows',
      lines: [
        'Install Bun (run in PowerShell):',
        '  powershell -c "irm bun.sh/install.ps1 | iex"',
        '',
        'Then close and reopen your terminal, and re-run this command.',
      ],
    };
  }
  if (platform === 'darwin') {
    return {
      platformName: 'macOS',
      lines: [
        'Install Bun:',
        '  curl -fsSL https://bun.sh/install | bash',
        '',
        'Then reload your shell (source ~/.zshrc) and re-run this command.',
      ],
    };
  }
  return {
    platformName: 'Linux',
    lines: [
      'Install Bun:',
      '  curl -fsSL https://bun.sh/install | bash',
      '',
      'Then reload your shell (source ~/.bashrc) and re-run this command.',
    ],
  };
}

/**
 * bin/blueprint.js lives one directory below the repo root (bin/blueprint.js
 * -> repo root), the same layout scripts/setup.js already resolves itself
 * against. Resolving from import.meta.url — not process.cwd() — keeps this
 * correct no matter where the process was invoked from: under npx the cwd
 * is the user's own shell directory, not the fetched-repo directory the
 * bin script actually lives in.
 */
export function repoRootFromBinScript(binScriptUrl) {
  return resolve(dirname(fileURLToPath(binScriptUrl)), '..');
}

/**
 * npx installs GitHub-sourced packages into a hashed cache directory
 * (~/.npm/_npx/<hash>/...). Purely cosmetic — used to add a one-line hint
 * to the printed next steps, never to change behaviour.
 */
export function isNpxCachePath(rootPath) {
  return /[\\/]_npx[\\/]/.test(rootPath);
}
