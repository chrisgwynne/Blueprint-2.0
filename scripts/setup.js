#!/usr/bin/env node
/**
 * Blueprint setup — cross-platform (Windows, macOS, Linux).
 *
 * Runs under Bun or Node. Does everything setup.sh does, but with no shell
 * dependency: reads/rewrites .env in JS, spawns child processes with the
 * correct interpreter for the platform, and uses path.join throughout.
 *
 * Usage:
 *   bun scripts/setup.js        # preferred
 *   node scripts/setup.js       # also works
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

const ansi = {
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s) => `\x1b[33m${s}\x1b[0m`,
  blue:  (s) => `\x1b[34m${s}\x1b[0m`,
};

function log(msg)  { console.log(msg); }
function ok(msg)   { log(`  ${ansi.green('✓')} ${msg}`); }
function warn(msg) { log(`  ${ansi.yellow('!')} ${msg}`); }
function step(msg) { log(`\n${ansi.bold(ansi.blue('▸'))} ${ansi.bold(msg)}`); }

function header() {
  log('');
  log(ansi.bold('  ╔══════════════════════════════════╗'));
  log(ansi.bold('  ║       Blueprint Setup            ║'));
  log(ansi.bold('  ╚══════════════════════════════════╝'));
  log('');
  log(`  Platform: ${ansi.dim(`${process.platform} (${process.arch})`)}`);
  log(`  Runtime:  ${ansi.dim(typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`)}`);
}

function hasCommand(cmd) {
  const which = IS_WINDOWS ? 'where' : 'which';
  const r = spawnSync(which, [cmd], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? ROOT,
    // On Windows, .cmd shims (like bun.cmd) need shell:true to resolve.
    shell: IS_WINDOWS,
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
  }
}

/* ─── Bun check ───────────────────────────────────────────────────────── */

function checkBun() {
  step('Checking for Bun');
  if (hasCommand('bun')) {
    ok('Bun is installed');
    return;
  }
  warn('Bun not found.');
  log('');
  if (IS_WINDOWS) {
    log('  Install Bun on Windows (run in PowerShell):');
    log(ansi.dim('    powershell -c "irm bun.sh/install.ps1 | iex"'));
    log('');
    log('  Then reopen your terminal and re-run this setup.');
  } else {
    log('  Install Bun:');
    log(ansi.dim('    curl -fsSL https://bun.sh/install | bash'));
    log('');
    log('  Then reopen your terminal and re-run this setup.');
  }
  process.exit(1);
}

/* ─── .env ────────────────────────────────────────────────────────────── */

function generateKey() {
  return randomBytes(32).toString('hex');
}

function ensureEnv() {
  step('Configuring environment');
  const envPath = join(ROOT, '.env');
  const examplePath = join(ROOT, '.env.example');
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      warn('.env.example missing — cannot bootstrap .env');
      return;
    }
    copyFileSync(examplePath, envPath);
    ok('Created .env from .env.example');
  } else {
    ok('.env already exists');
  }

  let content = readFileSync(envPath, 'utf8');
  let changed = false;

  if (content.includes('replace-with-64-char-hex-string-generated-by-openssl-rand-hex-32')) {
    content = content.replace(
      'replace-with-64-char-hex-string-generated-by-openssl-rand-hex-32',
      generateKey()
    );
    changed = true;
    ok('Generated encryption key');
  }
  if (content.includes('replace-with-another-64-char-hex-string-for-session-signing')) {
    content = content.replace(
      'replace-with-another-64-char-hex-string-for-session-signing',
      generateKey()
    );
    changed = true;
    ok('Generated session secret');
  }
  if (changed) writeFileSync(envPath, content, 'utf8');
}

/* ─── Data directory ──────────────────────────────────────────────────── */

function ensureDataDir() {
  const dataDir = join(ROOT, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    ok('Created data/ directory');
  }
}

/* ─── Install ─────────────────────────────────────────────────────────── */

function installDeps() {
  step('Installing server dependencies');
  run('bun', ['install'], { cwd: join(ROOT, 'server') });
  ok('Server dependencies installed');

  step('Installing client dependencies');
  run('bun', ['install'], { cwd: join(ROOT, 'client') });
  ok('Client dependencies installed');
}

function initDatabase() {
  step('Initialising database');
  run('bun', ['run', 'db/init.js'], { cwd: join(ROOT, 'server') });
  ok('Database initialised');
}

function buildClient() {
  step('Building frontend');
  run('bun', ['run', 'build'], { cwd: join(ROOT, 'client') });
  ok('Frontend built');
}

/* ─── Done ────────────────────────────────────────────────────────────── */

function footer() {
  log('');
  log(ansi.bold('  ╔══════════════════════════════════╗'));
  log(ansi.bold('  ║       Setup Complete! ✓          ║'));
  log(ansi.bold('  ╚══════════════════════════════════╝'));
  log('');
  log('  Next steps:');
  log('');
  log('    1. Configure your LLM provider in .env');
  log('       Ollama (free, local — no API key needed):');
  log(ansi.dim('         Install:  https://ollama.ai'));
  log(ansi.dim('         Run:      ollama pull llama3'));
  log('       Or add an API key: Anthropic, OpenAI, or Gemini');
  log('       See .env.example for all options.');
  log('');
  log('    2. Start Blueprint:');
  log(ansi.dim('       bun run dev            # dev mode (server + client)'));
  log(ansi.dim('       bun run start          # production'));
  log('');
  log(`    3. Open ${ansi.blue('http://localhost:4000')}`);
  log('');
}

/* ─── Main ────────────────────────────────────────────────────────────── */

try {
  header();
  checkBun();
  ensureEnv();
  ensureDataDir();
  installDeps();
  initDatabase();
  buildClient();
  footer();
} catch (err) {
  log('');
  log(ansi.red(`Setup failed: ${err.message}`));
  log('');
  log('  If the error is about a missing native module on Windows, try:');
  log(ansi.dim('    bun install --force'));
  log('  Or see README.md for the platform-specific troubleshooting section.');
  process.exit(1);
}
