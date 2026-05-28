#!/usr/bin/env bun
/**
 * Compiles the Blueprint Express server into a standalone binary
 * for use as a Tauri sidecar. Run before `tauri build`.
 *
 * Usage: bun scripts/build-sidecar.js
 * Or via npm script: bun run build:sidecar
 */

import { spawnSync } from 'child_process';
import { arch } from 'os';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const OUT_DIR   = join(REPO_ROOT, 'client', 'src-tauri', 'binaries');
mkdirSync(OUT_DIR, { recursive: true });

const machine = arch(); // 'arm64' on Apple Silicon, 'x64' on Intel
const target  = machine === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
const triple  = machine === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const outFile = join(OUT_DIR, `blueprint-server-${triple}`);

console.log(`\nBuilding Blueprint sidecar for ${triple}...`);

const result = spawnSync('bun', [
  'build',
  '--compile',
  `--target=${target}`,
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
