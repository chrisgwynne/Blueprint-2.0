/**
 * Server-access connection layer.
 *
 * Wraps ssh2 (SSH + SFTP) and basic-ftp (FTP/SFTP fallback) behind a single
 * ServerConnection interface.
 */
import crypto from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import type { SFTPWrapper, Stats as SFTPStats } from 'ssh2';
import { Client as FtpClient, FileType } from 'basic-ftp';
import { Writable, Readable } from 'node:stream';

import {
  isPathSafe, isSizeSafe, isReadableFile, scanForSecrets,
  MAX_FILE_SIZE, MAX_LIST_DEPTH, MAX_LIST_FILES,
} from './security.js';

// ─── Credential / config types ───────────────────────────────────────────────

interface ServerAccessCredentials {
  host: string;
  port?: number | string;
  username: string;
  password?: string;
  connectionMethod?: 'ssh-key' | 'password' | 'ssh-password' | 'sftp' | 'ftp' | 'ftps';
  privateKey?: string;
  passphrase?: string;
  rootPath?: string;
}
interface ServerAccessConfig {
  rootPath?: string;
}

interface FileReadResult {
  refused: boolean;
  path: string;
  size: number;
  reason?: string;
  matched?: unknown;
  modified?: string | null;
  content?: string;
  hash?: string;
}

interface FileWriteResult {
  path: string;
  bytes_written: number;
  hash: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 60_000;

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function streamToBuffer(readable: Readable, maxBytes: number = MAX_FILE_SIZE): Promise<Buffer> {
  return new Promise((resolveFn, rejectFn) => {
    const chunks: Buffer[] = [];
    let total = 0;
    readable.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        readable.destroy(new Error(`file exceeds size limit (${MAX_FILE_SIZE} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    readable.on('end', () => resolveFn(Buffer.concat(chunks)));
    readable.on('error', rejectFn);
  });
}

// ─── SSH/SFTP connection ────────────────────────────────────────────────────

class SshConnection {
  credentials: ServerAccessCredentials;
  config: ServerAccessConfig;
  rootPath: string | undefined;
  client: SshClient | null;
  sftp: SFTPWrapper | null;

  constructor(credentials: ServerAccessCredentials, config: ServerAccessConfig) {
    this.credentials = credentials;
    this.config = config;
    this.rootPath = config?.rootPath || credentials?.rootPath;
    this.client = null;
    this.sftp = null;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new SshClient();
    const connectOpts: Record<string, unknown> = {
      host: this.credentials.host,
      port: Number(this.credentials.port || 22),
      username: this.credentials.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
    };
    if (this.credentials.connectionMethod === 'ssh-key' && this.credentials.privateKey) {
      connectOpts.privateKey = this.credentials.privateKey;
      if (this.credentials.passphrase) connectOpts.passphrase = this.credentials.passphrase;
    } else if (this.credentials.password) {
      connectOpts.password = this.credentials.password;
    } else {
      throw new Error('SSH: neither password nor privateKey provided.');
    }

    await new Promise<void>((resolveFn, rejectFn) => {
      const to = setTimeout(() => rejectFn(new Error('SSH connect timed out')), CONNECT_TIMEOUT_MS);
      this.client!.once('ready', () => { clearTimeout(to); resolveFn(); });
      this.client!.once('error', (err: Error) => { clearTimeout(to); rejectFn(err); });
      this.client!.connect(connectOpts);
    });

    this.sftp = await new Promise((resolveFn, rejectFn) => {
      this.client!.sftp((err: Error | undefined, sftp: SFTPWrapper) => err ? rejectFn(err) : resolveFn(sftp));
    });
  }

  async disconnect(): Promise<void> {
    try { this.client?.end(); } catch {}
    this.client = null;
    this.sftp = null;
  }

  exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveFn, rejectFn) => {
      const to = setTimeout(() => rejectFn(new Error('SSH exec timed out')), OPERATION_TIMEOUT_MS);
      this.client!.exec(command, (err: Error | undefined, stream: NodeJS.ReadableStream & { stderr: NodeJS.ReadableStream; on(event: 'close', listener: (code: number) => void): void }) => {
        if (err) { clearTimeout(to); return rejectFn(err); }
        let stdout = '', stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        stream.on('close', (code: number) => {
          clearTimeout(to);
          resolveFn({ code, stdout, stderr });
        });
      });
    });
  }

  async listDirectory(remotePath: string, { depth = 1 } = {}): Promise<Array<{ path: string; name: string; size: number; modified: string; type: string }>> {
    if (!isPathSafe(remotePath, this.rootPath!)) {
      throw new Error(`listDirectory refused — path outside root or blocked: ${remotePath}`);
    }
    const d = Math.min(Math.max(1, depth), MAX_LIST_DEPTH);
    const cmd = `find ${JSON.stringify(remotePath)} -maxdepth ${d} -type f -size -${Math.ceil(MAX_FILE_SIZE / 1024)}k -printf '%p\\t%s\\t%T@\\n' 2>/dev/null | head -n ${MAX_LIST_FILES}`;
    const { stdout } = await this.exec(cmd);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const path = parts[0] ?? '';
        const size = parts[1] ?? '0';
        const mtime = parts[2] ?? '0';
        return {
          path,
          name: path.split('/').pop() ?? '',
          size: Number(size) || 0,
          modified: new Date(Number(mtime) * 1000).toISOString(),
          type: 'file',
        };
      })
      .filter((f) => isReadableFile(f.path));
  }

  async stat(remotePath: string): Promise<SFTPStats> {
    if (!isPathSafe(remotePath, this.rootPath!)) {
      throw new Error(`stat refused — path outside root or blocked: ${remotePath}`);
    }
    return new Promise((resolveFn, rejectFn) => {
      this.sftp!.stat(remotePath, (err: Error | undefined, attrs: SFTPStats) => err ? rejectFn(err) : resolveFn(attrs));
    });
  }

  async readFile(remotePath: string): Promise<FileReadResult> {
    if (!isPathSafe(remotePath, this.rootPath!)) {
      throw new Error(`readFile refused — path outside root or blocked: ${remotePath}`);
    }
    const attrs = await this.stat(remotePath);
    if (!isSizeSafe(attrs.size)) {
      throw new Error(`readFile refused — file exceeds ${MAX_FILE_SIZE} bytes (${attrs.size})`);
    }
    const buf = await new Promise<Buffer>((resolveFn, rejectFn) => {
      const stream = this.sftp!.createReadStream(remotePath);
      streamToBuffer(stream).then(resolveFn, rejectFn);
    });
    const content = buf.toString('utf8');
    const { clean, matched } = scanForSecrets(content);
    if (!clean) {
      return {
        refused: true,
        reason: 'file_contains_secrets',
        matched,
        path: remotePath,
        size: attrs.size,
      };
    }
    return {
      refused: false,
      path: remotePath,
      size: attrs.size,
      modified: new Date(attrs.mtime * 1000).toISOString(),
      content,
      hash: hashContent(content),
    };
  }

  async writeFile(remotePath: string, content: string): Promise<FileWriteResult> {
    if (!isPathSafe(remotePath, this.rootPath!, { forWrite: true })) {
      throw new Error(`writeFile refused — path outside root, blocked, or wrong extension: ${remotePath}`);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
      throw new Error(`writeFile refused — content exceeds ${MAX_FILE_SIZE} bytes`);
    }
    await new Promise<void>((resolveFn, rejectFn) => {
      const stream = this.sftp!.createWriteStream(remotePath);
      stream.on('close', resolveFn);
      stream.on('error', rejectFn);
      stream.end(content, 'utf8');
    });
    return {
      path: remotePath,
      bytes_written: Buffer.byteLength(content, 'utf8'),
      hash: hashContent(content),
    };
  }
}

// ─── FTP/FTPS connection ────────────────────────────────────────────────────

class FtpConnection {
  credentials: ServerAccessCredentials;
  config: ServerAccessConfig;
  rootPath: string | undefined;
  client: FtpClient | null;

  constructor(credentials: ServerAccessCredentials, config: ServerAccessConfig) {
    this.credentials = credentials;
    this.config = config;
    this.rootPath = config?.rootPath || credentials?.rootPath;
    this.client = null;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = new FtpClient(CONNECT_TIMEOUT_MS);
    this.client.ftp.verbose = false;
    await this.client.access({
      host: this.credentials.host,
      port: Number(this.credentials.port || 21),
      user: this.credentials.username,
      password: this.credentials.password,
      secure: this.credentials.connectionMethod === 'ftps' ? true : false,
    });
  }

  async disconnect(): Promise<void> {
    try { this.client?.close(); } catch {}
    this.client = null;
  }

  async exec(): Promise<never> {
    throw new Error('exec not supported on FTP connection.');
  }

  async listDirectory(remotePath: string, { depth = 1 } = {}): Promise<Array<{ path: string; name: string; size: number | undefined; modified: string | null; type: string }>> {
    if (!isPathSafe(remotePath, this.rootPath!)) {
      throw new Error(`listDirectory refused — path outside root or blocked: ${remotePath}`);
    }
    const items = await this.client!.list(remotePath);
    const out: Array<{ path: string; name: string; size: number | undefined; modified: string | null; type: string }> = [];
    for (const item of items) {
      if (item.type !== FileType.File) continue;
      const full = `${remotePath.replace(/\/$/, '')}/${item.name}`;
      if (!isReadableFile(full)) continue;
      if (!isSizeSafe(item.size)) continue;
      out.push({
        path: full,
        name: item.name,
        size: item.size,
        modified: item.modifiedAt?.toISOString() ?? null,
        type: 'file',
      });
      if (out.length >= MAX_LIST_FILES) break;
    }
    return out;
  }

  async stat(remotePath: string): Promise<{ size: number; mtime: number | null }> {
    const parent = remotePath.replace(/\/[^/]+$/, '');
    const name = remotePath.split('/').pop();
    const items = await this.client!.list(parent);
    const f = items.find((i) => i.name === name);
    if (!f) throw new Error(`File not found: ${remotePath}`);
    return { size: f.size, mtime: f.modifiedAt ? f.modifiedAt.getTime() / 1000 : null };
  }

  async readFile(remotePath: string): Promise<FileReadResult> {
    if (!isPathSafe(remotePath, this.rootPath!)) {
      throw new Error(`readFile refused — path outside root or blocked: ${remotePath}`);
    }
    const attrs = await this.stat(remotePath);
    if (!isSizeSafe(attrs.size)) {
      throw new Error(`readFile refused — file exceeds ${MAX_FILE_SIZE} bytes (${attrs.size})`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const writable = new Writable({
      write(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > MAX_FILE_SIZE) return cb(new Error('size limit exceeded'));
        chunks.push(chunk);
        cb();
      },
    });
    await this.client!.downloadTo(writable, remotePath);
    const content = Buffer.concat(chunks).toString('utf8');
    const { clean, matched } = scanForSecrets(content);
    if (!clean) {
      return { refused: true, reason: 'file_contains_secrets', matched, path: remotePath, size: attrs.size };
    }
    return {
      refused: false,
      path: remotePath,
      size: attrs.size,
      modified: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
      content,
      hash: hashContent(content),
    };
  }

  async writeFile(remotePath: string, content: string): Promise<FileWriteResult> {
    if (!isPathSafe(remotePath, this.rootPath!, { forWrite: true })) {
      throw new Error(`writeFile refused — path outside root, blocked, or wrong extension: ${remotePath}`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_SIZE) {
      throw new Error(`writeFile refused — content exceeds ${MAX_FILE_SIZE} bytes`);
    }
    const readable = Readable.from([Buffer.from(content, 'utf8')]);
    await this.client!.uploadFrom(readable, remotePath);
    return {
      path: remotePath,
      bytes_written: bytes,
      hash: hashContent(content),
    };
  }
}

// ─── Public factory ─────────────────────────────────────────────────────────

/**
 * Create a connection of the right kind based on credentials.connectionMethod.
 */
export async function createServerConnection(credentials: ServerAccessCredentials, config: ServerAccessConfig = {}): Promise<SshConnection | FtpConnection> {
  const method = credentials?.connectionMethod || 'ssh-key';
  let conn: SshConnection | FtpConnection;
  if (method === 'ssh-key' || method === 'ssh-password') {
    conn = new SshConnection(credentials, config);
  } else if (method === 'sftp') {
    // SFTP-over-SSH2 reuses the SshConnection path (password auth).
    conn = new SshConnection({ ...credentials, connectionMethod: 'ssh-password' }, config);
  } else if (method === 'ftp' || method === 'ftps') {
    conn = new FtpConnection(credentials, config);
  } else {
    throw new Error(`Unknown connectionMethod: ${method}`);
  }
  await conn.connect();
  return conn;
}

export { hashContent };
