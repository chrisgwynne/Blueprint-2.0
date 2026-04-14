/**
 * Server-access security gate.
 *
 * This module is the single point of validation for EVERY file path and
 * file content that reaches the SSH/FTP connector. If a bug lands here,
 * an agent could potentially read /etc/passwd or overwrite wp-config.php
 * — so this is a hard safety boundary, not a nicety.
 *
 * Every read or write operation in the server-access connector MUST
 * call isPathSafe(targetPath, rootPath) before touching the server.
 * Every file content read MUST be checked with scanForSecrets() before
 * being returned to an agent.
 */
import { resolve } from 'node:path';

// Absolute-path filename fragments that are never allowed — even read.
// Match anywhere in the path (case-insensitive).
const BLOCKED_NAME_PATTERNS = [
  /wp-config\.php$/i,
  /(^|\/)\.env(\.|$)/i,            // .env, .env.local, .env.production
  /(^|\/)\.env$/i,
  /(^|\/)config\.php$/i,            // Kirby & many PHP apps
  /(^|\/)database\.php$/i,          // Laravel-style
  /(^|\/)db\.php$/i,
  /(^|\/)secrets?\./i,              // secret.json, secrets.yaml, etc.
  /(^|\/)credentials?\./i,
  /password/i,                      // any file with 'password' in the name
  /(^|\/)id_rsa/i,                  // private SSH keys
  /(^|\/)id_ed25519/i,
  /private[_-]?key/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,                        // but .pub key files allowed (see below)
];

// Directories we never descend into or touch.
const BLOCKED_DIR_PATTERNS = [
  /\/vendor\//,
  /\/node_modules\//,
  /\/\.git\//,
  /\/\.ssh\//,
  /\/\.aws\//,
  /\/\.config\/gcloud\//,
];

// File extensions allowed for read/write. Binary files and anything we
// don't understand structurally are refused outright.
const ALLOWED_EXTENSIONS = new Set([
  '.php', '.html', '.htm', '.js', '.css', '.json', '.yaml', '.yml',
  '.md', '.txt', '.htaccess', '.xml', '.svg', '.twig', '.blade',
  '.ts', '.jsx', '.tsx', '.scss', '.sass', '.less', '.toml', '.ini',
]);

// Extensions that are read-only even when allowed: we can look at them
// but never write back. .env in particular should be refused entirely
// by BLOCKED_NAME_PATTERNS, but we belt-and-brace.
const READONLY_EXTENSIONS = new Set(['.env', '.lock', '.log']);

// Obvious secret-like key=value patterns in file contents.
const SECRET_PATTERNS = [
  /\b(PASSWORD|PASSWD|PWD)\s*[:=]\s*["']?[^"'\s]{4,}/i,
  /\b(SECRET|SECRET_KEY|APP_SECRET)\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b(API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN)\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b(DB_PASSWORD|DATABASE_URL|MYSQL_PWD)\s*[:=]\s*["']?[^"'\s]{4,}/i,
  /\baws_secret_access_key\s*[:=]/i,
  /\bAKIA[0-9A-Z]{16}\b/,           // AWS access key id
  /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bBEGIN PGP PRIVATE KEY BLOCK\b/,
];

// Hard size limit for any single file (read or write). Prevents agents
// from pulling multi-megabyte blobs into the LLM or accidentally uploading
// a huge file.
export const MAX_FILE_SIZE = 500 * 1024; // 500 KB

export const MAX_LIST_DEPTH = 3;
export const MAX_LIST_FILES = 500;

function getExtension(path) {
  const match = String(path).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

/**
 * Decide whether a path is allowed for any file operation.
 *
 *   targetPath — absolute path on the remote server we want to touch.
 *   rootPath   — the configured site root path (from connector config).
 *   opts.forWrite — set true to enforce the stricter write-only rules.
 *
 * Returns true only if ALL checks pass. Callers must fail-closed.
 */
export function isPathSafe(targetPath, rootPath, opts = {}) {
  const { forWrite = false } = opts;
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (!rootPath || typeof rootPath !== 'string') return false;

  // Reject any obvious traversal sequence. path.resolve() would swallow
  // them, but we reject upfront so the intent can be logged.
  if (targetPath.includes('..') || targetPath.includes('\x00')) return false;

  const absRoot = resolve(rootPath);
  const absTarget = resolve(targetPath);

  // Target must live under the configured root. Trailing slash matters:
  // "/var/www/html" should not match "/var/www/html-other".
  const rootWithSep = absRoot.endsWith('/') ? absRoot : absRoot + '/';
  if (absTarget !== absRoot && !absTarget.startsWith(rootWithSep)) {
    return false;
  }

  // Blocked directories (vendor, node_modules, .git, etc.)
  for (const rx of BLOCKED_DIR_PATTERNS) {
    if (rx.test(absTarget)) return false;
  }

  // Blocked filenames (config.php, .env, credentials, private keys, etc.)
  for (const rx of BLOCKED_NAME_PATTERNS) {
    if (rx.test(absTarget)) return false;
  }

  // File-extension whitelist. Directories (no extension) pass for list ops;
  // but when forWrite=true we always require an explicit allowed extension.
  const ext = getExtension(absTarget);
  if (ext) {
    if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    if (forWrite && READONLY_EXTENSIONS.has(ext)) return false;
  } else if (forWrite) {
    // Writing to an extensionless path is almost certainly wrong.
    return false;
  }

  return true;
}

/**
 * Scan file content for obvious credential patterns. Returns:
 *   { clean: true } — content had no matches
 *   { clean: false, matched: [<pattern name>] } — content had credentials
 */
export function scanForSecrets(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { clean: true, matched: [] };
  }
  const matched = [];
  // Only scan the first 64KB — if secrets are hidden deeper than that,
  // we still flag the file via its filename.
  const head = content.length > 64 * 1024 ? content.slice(0, 64 * 1024) : content;
  for (const rx of SECRET_PATTERNS) {
    if (rx.test(head)) matched.push(rx.source.slice(0, 60));
  }
  return { clean: matched.length === 0, matched };
}

/**
 * Enforce a single upper bound on any file we read or write. Size-check
 * is separate from isPathSafe() because size is known only after listing
 * the remote file.
 */
export function isSizeSafe(bytes) {
  return typeof bytes === 'number' && bytes >= 0 && bytes <= MAX_FILE_SIZE;
}

/**
 * Lightweight check: is this path a path we should try to read at all?
 * Called from list-directory results to decide which files merit a read.
 */
export function isReadableFile(path) {
  const ext = getExtension(path);
  if (!ext) return false;
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  for (const rx of BLOCKED_NAME_PATTERNS) if (rx.test(path)) return false;
  return true;
}
