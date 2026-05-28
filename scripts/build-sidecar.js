#!/usr/bin/env bun
/**
 * Compiles the Blueprint Express server into a standalone binary
 * for use as a Tauri sidecar. Run before `tauri build`.
 *
 * Usage: bun scripts/build-sidecar.js
 * Or via npm script: bun run build:sidecar
 *
 * Detects the host OS + arch and compiles for the matching Rust target triple.
 * Tauri looks for binaries named  blueprint-server-{triple}[.exe]  in
 * client/src-tauri/binaries/.
 */

import { spawnSync } from 'child_process';
import { arch, platform } from 'os';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUT_DIR   = join(REPO_ROOT, 'client', 'src-tauri', 'binaries');
mkdirSync(OUT_DIR, { recursive: true });

const machine = arch();   // 'arm64' | 'x64' | 'ia32'
const os      = platform(); // 'darwin' | 'win32' | 'linux'

// Map host OS+arch → (Bun target, Rust target triple, exe suffix)
const TARGETS = {
  'darwin-arm64': ['bun-darwin-arm64',    'aarch64-apple-darwin',         ''],
  'darwin-x64':   ['bun-darwin-x64',      'x86_64-apple-darwin',          ''],
  'win32-x64':    ['bun-windows-x64',     'x86_64-pc-windows-msvc',       '.exe'],
  'win32-arm64':  ['bun-windows-arm64',   'aarch64-pc-windows-msvc',      '.exe'],
  'linux-x64':    ['bun-linux-x64',       'x86_64-unknown-linux-gnu',     ''],
  'linux-arm64':  ['bun-linux-arm64',     'aarch64-unknown-linux-gnu',    ''],
};

const key = `${os}-${machine}`;
const entry = TARGETS[key];
if (!entry) {
  console.error(`Unsupported platform: ${key}. Add it to build-sidecar.js.`);
  process.exit(1);
}

const [bunTarget, triple, exeSuffix] = entry;
const outFile = join(OUT_DIR, `blueprint-server-${triple}${exeSuffix}`);

console.log(`\nBuilding Blueprint sidecar for ${triple}...`);

const result = spawnSync('bun', [
  'build',
  '--compile',
  `--target=${bunTarget}`,
  join(REPO_ROOT, 'server', 'index.ts'),
  '--outfile', outFile,
], {
  stdio: 'inherit',
  cwd: REPO_ROOT,
});

if (result.status !== 0) {
  console.error('\nSidecar build failed.');
  process.exit(1);
}

console.log(`\nSidecar ready: ${outFile}`);
