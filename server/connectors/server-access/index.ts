/**
 * Server-access connector — SSH / SFTP / FTP.
 *
 * Gives the Dev agent (and others) the ability to read code files on a
 * remote web server, and — with human approval — write specific files back.
 *
 * Safety model:
 *   READ    — always allowed, gated by security.js (path + secret scans).
 *   WRITE   — only via the task executor after human approval.
 *              Every write backs up the current file content to
 *              file_backups first. Rollback is a separate approved task.
 *   DELETE  — never supported. Not implemented.
 *
 * Credentials are stored encrypted via server/crypto.js. Private keys are
 * stored as plain strings in the credentials blob before encryption.
 */
import { createServerConnection } from './connection.js';
import db from '../../db/db.js';
import { isPathSafe, isReadableFile } from './security.js';

type Creds = Record<string, string | undefined>;

// Structural type covering both SSH and FTP connections — exec is SSH-only
// (guarded by `isSsh` checks at every call site).
type ServerConn = {
  exec(cmd: string): Promise<{ stdout: string; code?: number }>;
  disconnect(): Promise<void>;
  listDirectory(path: string, opts?: { depth?: number }): Promise<Array<Record<string, unknown>>>;
  readFile(path: string): Promise<{ content: string; hash: string; refused?: boolean }>;
  writeFile?(path: string, content: string): Promise<void>;
};

// Known site structures we try to inventory after healthCheck. Each entry
// is an array of directory paths (relative to rootPath) worth scanning.
const SITE_STRUCTURES: Record<string, string[]> = {
  kirby:     ['content', 'site/templates', 'site/snippets', 'site/plugins', 'site/config'],
  wordpress: ['wp-content/themes', 'wp-content/plugins'],
  static:    ['', 'assets/css', 'assets/js'],
  laravel:   ['resources/views', 'public', 'routes'],
  custom:    [''],
};

function joinRoot(rootPath: string, sub: string): string {
  if (!sub) return rootPath;
  return `${rootPath.replace(/\/$/, '')}/${sub.replace(/^\//, '')}`;
}

// Lightweight heuristics to flag obvious issues in PHP / HTML / JS files.
function analyseFileContent(path: string, content: string): Array<{ type: string; severity: string }> {
  const issues: Array<{ type: string; severity: string }> = [];
  const lower = path.toLowerCase();
  if (lower.endsWith('.php')) {
    if (/\beval\s*\(/.test(content)) issues.push({ type: 'eval_usage', severity: 'warning' });
    if (/\bexec\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/.test(content)) {
      issues.push({ type: 'command_injection_risk', severity: 'alert' });
    }
    if (/mysql_(query|connect)\s*\(/.test(content)) {
      issues.push({ type: 'deprecated_mysql_ext', severity: 'warning' });
    }
    if (/\becho\s+\$_(GET|POST|REQUEST|COOKIE)\s*\[/.test(content)) {
      issues.push({ type: 'unescaped_output_xss_risk', severity: 'warning' });
    }
  }
  if (lower.endsWith('.js') && /eval\s*\(/.test(content)) {
    issues.push({ type: 'eval_usage', severity: 'info' });
  }
  return issues;
}

// Error log parsing — best-effort, works for Apache/Nginx/PHP logs.
function parseErrorLog(text: string): Array<{ timestamp: string | null; type: string; line: string }> {
  const lines = String(text).split('\n').filter(Boolean);
  const entries: Array<{ timestamp: string | null; type: string; line: string }> = [];
  for (const line of lines) {
    let type = 'info';
    if (/PHP Fatal/i.test(line)) type = 'fatal';
    else if (/PHP Parse/i.test(line)) type = 'fatal';
    else if (/PHP Warning/i.test(line)) type = 'warning';
    else if (/PHP Notice|PHP Deprecated/i.test(line)) type = 'notice';
    else if (/\[error\]/i.test(line)) type = 'error';
    else if (/\b404\b/.test(line)) type = '404';
    else if (/\b5\d\d\b/.test(line)) type = '5xx';
    // Extract timestamp if bracketed.
    const ts = line.match(/\[([^\]]+)\]/)?.[1] ?? null;
    entries.push({ timestamp: ts, type, line: line.slice(0, 500) });
  }
  return entries;
}

async function maybeDiskUsage(conn: { exec: (cmd: string) => Promise<{ stdout: string }> }): Promise<number | null> {
  try {
    const { stdout } = await conn.exec("df -h --output=pcent . | tail -1 | tr -dc '0-9'");
    const pct = parseInt(stdout.trim(), 10);
    return Number.isFinite(pct) ? pct : null;
  } catch { return null; }
}

async function maybePhpVersion(conn: { exec: (cmd: string) => Promise<{ stdout: string }> }): Promise<string | null> {
  try {
    const { stdout } = await conn.exec('php -r "echo PHP_VERSION;" 2>/dev/null');
    return stdout.trim() || null;
  } catch { return null; }
}

async function maybeReadErrorLog(
  conn: { exec: (cmd: string) => Promise<{ stdout: string; code?: number }> },
  rootPath: string
): Promise<{ logPath: string | null; entries: Array<{ timestamp: string | null; type: string; line: string }> }> {
  const candidates = [
    '/var/log/apache2/error.log',
    '/var/log/nginx/error.log',
    `${rootPath}/../logs/error.log`,
    `${rootPath}/error_log`,
    `${rootPath}/error.log`,
  ];
  for (const path of candidates) {
    try {
      const { stdout, code } = await conn.exec(`tail -n 100 ${JSON.stringify(path)} 2>/dev/null`);
      if (code === 0 && stdout.trim()) {
        return { logPath: path, entries: parseErrorLog(stdout) };
      }
    } catch {}
  }
  return { logPath: null, entries: [] };
}

const connector = {
  id: 'server-access' as const,
  name: 'Server Access (SSH/FTP)',
  category: 'infrastructure',
  authType: 'apikey', // credentials (host, username, password/key) entered as config
  icon: 'server',

  capabilities: {
    read: true,
    write: true,
    writeRequiresApproval: true,   // NEVER auto-execute, always via approved task
    supportsDelete: false,
    webhooks: false,
    pollingIntervalMinutes: 1440,  // daily — file structure changes slowly
  },

  configFields: [
    {
      id: 'connectionMethod', label: 'Connection method', type: 'select', required: true,
      default: 'ssh-key',
      options: [
        { value: 'ssh-key',      label: 'SSH with private key (recommended)' },
        { value: 'ssh-password', label: 'SSH with password' },
        { value: 'sftp',         label: 'SFTP (password)' },
        { value: 'ftps',         label: 'FTPS (explicit TLS)' },
        { value: 'ftp',          label: 'FTP (unencrypted — not recommended)' },
      ],
    },
    { id: 'host',       label: 'Hostname or IP', type: 'text',     required: true,  placeholder: 'server.example.com' },
    { id: 'port',       label: 'Port',           type: 'number',   required: true,  default: 22 },
    { id: 'username',   label: 'Username',       type: 'text',     required: true },
    { id: 'password',   label: 'Password',       type: 'password', required: false,
      hint: 'Required for ssh-password, sftp, ftp, ftps methods.' },
    { id: 'privateKey', label: 'Private key (SSH only)', type: 'textarea', required: false,
      hint: 'Paste the contents of your id_rsa/id_ed25519 file. Required for ssh-key.' },
    { id: 'passphrase', label: 'Key passphrase',  type: 'password', required: false,
      hint: 'Only if your private key is passphrase-protected.' },
    { id: 'rootPath',   label: 'Site root path',  type: 'text',     required: true,
      placeholder: '/var/www/html', hint: 'Absolute path to the website root on the server.' },
    { id: 'siteType',   label: 'Site type',       type: 'select',   required: true,
      default: 'custom',
      options: [
        { value: 'kirby',     label: 'Kirby' },
        { value: 'wordpress', label: 'WordPress' },
        { value: 'static',    label: 'Static HTML' },
        { value: 'laravel',   label: 'Laravel' },
        { value: 'custom',    label: 'Custom' },
      ],
    },
  ],

  signalTypes: [
    'server_php_errors_spike',
    'server_php_fatal_error',
    'server_disk_usage_high',
    'server_unexpected_file_change',
  ],

  async healthCheck(credentials: Creds, config: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    let conn: ServerConn | undefined;
    try {
      conn = await createServerConnection(credentials, config) as unknown as ServerConn;
      // Cheap canary: the connection itself succeeding is 90% of the signal.
      // If SSH, run a trivial exec to confirm we can execute commands.
      const serverInfo: Record<string, unknown> = { method: credentials.connectionMethod };
      if (credentials.connectionMethod?.startsWith('ssh')) {
        try {
          const { stdout: uname } = await conn.exec('uname -sr 2>/dev/null');
          serverInfo.os = uname.trim() || null;
        } catch {}
      }
      return { ok: true, details: serverInfo };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      if (conn) await conn.disconnect();
    }
  },

  async fetch(_dataType: string, credentials: Creds, params: Record<string, unknown> = {}): Promise<unknown> {
    const config: Record<string, unknown> = { rootPath: credentials.rootPath, siteType: credentials.siteType, ...params };
    const rootPath = config.rootPath as string | undefined;
    if (!rootPath) throw new Error('server-access: rootPath not configured.');

    const siteType = (config.siteType as string | undefined) || 'custom';
    const dirsToScan = SITE_STRUCTURES[siteType] ?? SITE_STRUCTURES.custom;

    const conn = await createServerConnection(credentials, config) as unknown as ServerConn;
    try {
      const isSsh = credentials.connectionMethod?.startsWith('ssh');

      // 1. File inventory across known directories for this site type.
      const siteFiles: Array<Record<string, unknown>> = [];
      for (const sub of dirsToScan) {
        const target = joinRoot(rootPath, sub);
        if (!isPathSafe(target, rootPath)) continue;
        try {
          const files = await conn.listDirectory(target, { depth: 2 });
          for (const f of files) siteFiles.push(f);
          if (siteFiles.length >= 500) break;
        } catch (err) {
          console.warn(`[server-access] list ${target} failed:`, (err as Error).message);
        }
      }

      // 2. Server metadata (SSH only).
      let os: string | null = null;
      let phpVersion: string | null = null;
      let diskUsagePct: number | null = null;
      if (isSsh) {
        try {
          const { stdout } = await conn.exec('uname -sr 2>/dev/null');
          os = stdout.trim() || null;
        } catch {}
        phpVersion = await maybePhpVersion(conn);
        diskUsagePct = await maybeDiskUsage(conn);
      }

      // 3. Error log (best-effort).
      const { logPath, entries } = isSsh
        ? await maybeReadErrorLog(conn, rootPath)
        : { logPath: null, entries: [] };

      // 4. File-content analysis for the first N PHP/JS files, to surface
      //    security/deprecated issues without pulling every file into the LLM.
      const fileIssues: Array<{ path: string; issues: Array<{ type: string; severity: string }> }> = [];
      const toAnalyse = siteFiles
        .filter((f) => /\.(php|js)$/i.test(f.name as string))
        .slice(0, 25);
      for (const f of toAnalyse) {
        try {
          const res = await conn.readFile(f.path as string);
          if (res.refused) continue;
          const issues = analyseFileContent(f.path as string, res.content as string);
          if (issues.length > 0) fileIssues.push({ path: f.path as string, issues });
        } catch (err) {
          // Non-fatal — log and continue.
          console.warn(`[server-access] analyse ${f.path} failed:`, (err as Error).message);
        }
      }

      // 5. Detect external file changes (files whose hash changed since
      //    last cache entry, with no Blueprint write task between).
      const externalChanges: Array<{ path: string; size: unknown }> = [];
      try {
        const cache = db.prepare(
          `SELECT remote_path, content_hash FROM server_file_cache
           WHERE business_id = ? AND connector_id = ?`
        ).all(String(params['businessId'] ?? ''), String(params['connectorId'] ?? '')) as Array<{ remote_path: string; content_hash: string }>;
        const cacheMap = new Map(cache.map((r) => [r.remote_path, r.content_hash]));
        // Only re-check files we've already seen, to avoid full-content
        // fetches of every file on every sync.
        for (const f of siteFiles) {
          const prev = cacheMap.get(f.path as string);
          if (!prev) continue;
          try {
            const res = await conn.readFile(f.path as string);
            if (res.refused) continue;
            if (res.hash !== prev) {
              // Was this change caused by a Blueprint write task? If so,
              // a file_backups row for this path was created recently.
              const backup = db.prepare(
                `SELECT id FROM file_backups
                 WHERE connector_id = ? AND remote_path = ?
                 AND backed_up_at >= datetime('now','-2 hours')
                 ORDER BY backed_up_at DESC LIMIT 1`
              ).get(String(params['connectorId'] ?? ''), f.path as string);
              if (!backup) externalChanges.push({ path: f.path as string, size: f.size });
            }
          } catch {}
        }
      } catch (err) {
        console.warn('[server-access] external-change scan skipped:', (err as Error).message);
      }

      return {
        rootPath,
        siteType,
        serverInfo: { os, phpVersion, diskUsagePct },
        siteFiles,
        errorLog: { logPath, entries },
        fileIssues,
        externalChanges,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      await conn.disconnect();
    }
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number; data: unknown }> {
    const metrics: Array<{ name: string; value: number; data: unknown }> = [];
    const d = data as Record<string, unknown> | null;
    const files = Array.isArray(d?.siteFiles) ? (d.siteFiles as Array<Record<string, unknown>>) : [];
    const errorLog = d?.errorLog as Record<string, unknown> | undefined;
    const errors = Array.isArray(errorLog?.entries) ? (errorLog.entries as Array<Record<string, unknown>>) : [];
    const issues = Array.isArray(d?.fileIssues) ? (d.fileIssues as Array<unknown>) : [];
    const external = Array.isArray(d?.externalChanges) ? (d.externalChanges as Array<unknown>) : [];

    const now = Date.now();
    const last24h = errors.filter((e) => {
      if (!e.timestamp) return true;
      const ts = new Date(e.timestamp as string).getTime();
      return Number.isFinite(ts) ? now - ts <= 24 * 3600_000 : true;
    });
    const fatal24h = last24h.filter((e) => e.type === 'fatal').length;

    const templateFiles = files.filter((f) =>
      /\/(templates|snippets|themes|views)\//.test(f.path as string) || /\.(php|twig|blade\.php|html)$/.test(f.name as string)
    ).length;
    const contentFiles = files.filter((f) =>
      /\/content\//.test(f.path as string) || /\.(md|txt)$/.test(f.name as string)
    ).length;

    const lastModified = files
      .map((f) => f.modified ? new Date(f.modified as string).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);

    const serverInfo = d?.serverInfo as Record<string, unknown> | undefined;

    metrics.push(
      { name: 'server.files_total',           value: files.length,                             data: null },
      { name: 'server.php_errors_24h',        value: last24h.length,                           data: null },
      { name: 'server.php_fatal_errors_24h',  value: fatal24h,                                 data: null },
      { name: 'server.disk_usage_pct',        value: (serverInfo?.diskUsagePct as number) ?? 0, data: null },
      { name: 'server.last_modified_file',    value: lastModified, data: { iso: lastModified ? new Date(lastModified).toISOString() : null } },
      { name: 'server.template_files_count',  value: templateFiles,                            data: null },
      { name: 'server.content_files_count',   value: contentFiles,                             data: null },
      { name: 'server.external_changes_count', value: external.length,                         data: null },
    );

    metrics.push(
      { name: 'server.site_structure',  value: files.length,   data: files.slice(0, 300) },
      { name: 'server.recent_errors',   value: errors.length,  data: errors.slice(0, 100) },
      { name: 'server.file_issues',     value: issues.length,  data: issues },
      { name: 'server.external_changes', value: external.length, data: external },
    );

    return metrics;
  },

  async getAuthUrl(_state: string): Promise<string> { throw new Error('server-access does not use OAuth.'); },
  async exchangeCode(_code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> { throw new Error('server-access does not use OAuth.'); },
  async refreshToken(credentials: Creds): Promise<{ accessToken: string; expiresAt?: string }> { return credentials as { accessToken: string; expiresAt?: string }; },

  // ─── Explicit read/write helpers (used by routes + executor) ───────────
  async readFile(credentials: Creds, remotePath: string): Promise<unknown> {
    const conn = await createServerConnection(credentials, { rootPath: credentials.rootPath }) as unknown as ServerConn;
    try { return await conn.readFile(remotePath); }
    finally { await conn.disconnect(); }
  },

  async listDirectory(credentials: Creds, remotePath: string, opts: Record<string, unknown> = {}): Promise<unknown[]> {
    const conn = await createServerConnection(credentials, { rootPath: credentials.rootPath }) as unknown as ServerConn;
    try { return await conn.listDirectory(remotePath, opts); }
    finally { await conn.disconnect(); }
  },
};

export default connector;
