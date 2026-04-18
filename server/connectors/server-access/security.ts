/**
 * Server-access security gate.
 */
import { resolve } from 'node:path';

// Absolute-path filename fragments that are never allowed — even read.
const BLOCKED_NAME_PATTERNS: RegExp[] = [
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
const BLOCKED_DIR_PATTERNS: RegExp[] = [
  /\/vendor\//,
  /\/node_modules\//,
  /\/\.git\//,
  /\/\.ssh\//,
  /\/\.aws\//,
  /\/\.config\/gcloud\//,
];

// File extensions allowed for read/write.
const ALLOWED_EXTENSIONS = new Set([
  '.php', '.html', '.htm', '.js', '.css', '.json', '.yaml', '.yml',
  '.md', '.txt', '.htaccess', '.xml', '.svg', '.twig', '.blade',
  '.ts', '.jsx', '.tsx', '.scss', '.sass', '.less', '.toml', '.ini',
]);

// Extensions that are read-only even when allowed.
const READONLY_EXTENSIONS = new Set(['.env', '.lock', '.log']);

// Obvious secret-like key=value patterns in file contents.
const SECRET_PATTERNS: RegExp[] = [
  /\b(PASSWORD|PASSWD|PWD)\s*[:=]\s*["']?[^"'\s]{4,}/i,
  /\b(SECRET|SECRET_KEY|APP_SECRET)\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b(API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN)\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b(DB_PASSWORD|DATABASE_URL|MYSQL_PWD)\s*[:=]\s*["']?[^"'\s]{4,}/i,
  /\baws_secret_access_key\s*[:=]/i,
  /\bAKIA[0-9A-Z]{16}\b/,           // AWS access key id
  /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bBEGIN PGP PRIVATE KEY BLOCK\b/,
];

// Hard size limit for any single file (read or write).
export const MAX_FILE_SIZE = 500 * 1024; // 500 KB

export const MAX_LIST_DEPTH = 3;
export const MAX_LIST_FILES = 500;

function getExtension(path: string): string {
  const match = String(path).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? (match[1] ?? '') : '';
}

/**
 * Decide whether a path is allowed for any file operation.
 */
export function isPathSafe(targetPath: string, rootPath: string, opts: { forWrite?: boolean } = {}): boolean {
  const { forWrite = false } = opts;
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (!rootPath || typeof rootPath !== 'string') return false;

  if (targetPath.includes('..') || targetPath.includes('\x00')) return false;

  const absRoot = resolve(rootPath);
  const absTarget = resolve(targetPath);

  const rootWithSep = absRoot.endsWith('/') ? absRoot : absRoot + '/';
  if (absTarget !== absRoot && !absTarget.startsWith(rootWithSep)) {
    return false;
  }

  for (const rx of BLOCKED_DIR_PATTERNS) {
    if (rx.test(absTarget)) return false;
  }

  for (const rx of BLOCKED_NAME_PATTERNS) {
    if (rx.test(absTarget)) return false;
  }

  const ext = getExtension(absTarget);
  if (ext) {
    if (!ALLOWED_EXTENSIONS.has(ext)) return false;
    if (forWrite && READONLY_EXTENSIONS.has(ext)) return false;
  } else if (forWrite) {
    return false;
  }

  return true;
}

/**
 * Scan file content for obvious credential patterns.
 */
export function scanForSecrets(content: string): { clean: boolean; matched: string[] } {
  if (typeof content !== 'string' || content.length === 0) {
    return { clean: true, matched: [] };
  }
  const matched: string[] = [];
  const head = content.length > 64 * 1024 ? content.slice(0, 64 * 1024) : content;
  for (const rx of SECRET_PATTERNS) {
    if (rx.test(head)) matched.push(rx.source.slice(0, 60));
  }
  return { clean: matched.length === 0, matched };
}

/**
 * Enforce a single upper bound on any file we read or write.
 */
export function isSizeSafe(bytes: number): boolean {
  return typeof bytes === 'number' && bytes >= 0 && bytes <= MAX_FILE_SIZE;
}

/**
 * Lightweight check: is this path a path we should try to read at all?
 */
export function isReadableFile(path: string): boolean {
  const ext = getExtension(path);
  if (!ext) return false;
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  for (const rx of BLOCKED_NAME_PATTERNS) if (rx.test(path)) return false;
  return true;
}
