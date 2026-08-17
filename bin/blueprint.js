#!/usr/bin/env node
/**
 * npx entry point — `npx github:chrisgwynne/Blueprint-2.0`.
 *
 * npx runs this file with the user's local Node (not Bun), from whatever
 * directory the user invoked it in — the fetched repo lives elsewhere
 * (npm's npx cache), so nothing here may depend on process.cwd(). Its job
 * is small on purpose: confirm Bun is available (Blueprint itself requires
 * Bun, not Node), then hand off to the existing scripts/setup.js — this
 * script does not reimplement any setup logic itself.
 *
 * Usage:
 *   npx github:chrisgwynne/Blueprint-2.0
 *   node bin/blueprint.js      # from an existing checkout
 *   bun bin/blueprint.js       # from an existing checkout
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bunInstallInstructions, hasCommand, isNpxCachePath, repoRootFromBinScript } from './lib.js';

const ROOT = repoRootFromBinScript(import.meta.url);
const SETUP_SCRIPT = join(ROOT, 'scripts', 'setup.js');
const IS_WINDOWS = process.platform === 'win32';

function log(msg = '') {
  console.log(msg);
}

function main() {
  log('');
  log('  Blueprint — setup');
  log('');

  if (!hasCommand('bun')) {
    const { platformName, lines } = bunInstallInstructions();
    log(`  Bun is not installed — Blueprint needs it to run (${platformName}).`);
    log('');
    for (const line of lines) log(`  ${line}`);
    log('');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(SETUP_SCRIPT)) {
    log(`  Could not find scripts/setup.js at:`);
    log(`    ${SETUP_SCRIPT}`);
    log('  The fetched Blueprint source looks incomplete — try again, or clone');
    log('  the repo directly: git clone https://github.com/chrisgwynne/Blueprint-2.0');
    process.exitCode = 1;
    return;
  }

  log(`  Setting up Blueprint in:`);
  log(`    ${ROOT}`);
  log('');

  const result = spawnSync('bun', [SETUP_SCRIPT], {
    stdio: 'inherit',
    cwd: ROOT,
    // On Windows, bun.cmd shims need shell:true to resolve (matches setup.js).
    shell: IS_WINDOWS,
    env: process.env,
  });

  if (result.error || result.status !== 0) {
    log('');
    log('  Setup failed — see the error above.');
    process.exitCode = result.status ?? 1;
    return;
  }

  log('');
  log('  Next steps:');
  log('');
  log(`    cd "${ROOT}"`);
  log('    bun run dev');
  log('');
  log('  Then open http://localhost:4000');
  if (isNpxCachePath(ROOT)) {
    log('');
    log('  Note: that path is a temporary npx cache directory. To keep this');
    log(`  install permanently, copy it somewhere first, e.g.:`);
    log(`    cp -r "${ROOT}" ~/blueprint && cd ~/blueprint && bun run dev`);
  }
  log('');
}

main();
