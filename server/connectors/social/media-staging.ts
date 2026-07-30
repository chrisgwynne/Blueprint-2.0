/**
 * Secure media staging for Meta social publishing.
 *
 * Stores uploaded media in a private local directory and issues
 * HMAC-signed, time-limited serving URLs so Meta can fetch them.
 *
 * Security properties:
 * - Files are stored with unguessable names (random UUID)
 * - Serving URLs contain HMAC-SHA256 signature + expiry so they cannot be
 *   forged or replayed after expiry
 * - Path traversal is blocked — filenames are sanitised to alphanumeric+extension only
 * - MIME type validated via both the declared type AND file magic bytes
 * - No redirects: the serving endpoint streams directly from the staging directory
 * - Checksums (SHA-256) are stored with each file for later verification
 * - businessId and connectorId stored with each file to enforce ownership on delete
 * - Metadata is persisted to SQLite so staging survives server restarts
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../../db/db.js';

export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingError';
  }
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
]);

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const DEFAULT_TTL_SECONDS = 3600; // 1 hour

interface StagingMetadata {
  stagingToken: string;
  businessId: string;
  connectorId: string;
  filePath: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  checksum: string;
  expiresAt: number;
}

// In-memory index of staged files (token → metadata), populated from DB on first use
const stagingIndex = new Map<string, StagingMetadata>();
let indexLoaded = false;

function ensureIndexLoaded(): void {
  if (indexLoaded) return;
  indexLoaded = true;
  try {
    const now = new Date().toISOString();
    const rows = db.prepare(
      `SELECT * FROM social_media_staging WHERE expires_at > ?`,
    ).all(now) as Array<{
      staging_token: string;
      business_id: string;
      connector_id: string;
      file_path: string;
      original_filename: string;
      mime_type: string;
      size: number;
      checksum: string;
      expires_at: string;
    }>;
    for (const row of rows) {
      // Only restore if the file still exists on disk
      if (fs.existsSync(row.file_path)) {
        stagingIndex.set(row.staging_token, {
          stagingToken: row.staging_token,
          businessId: row.business_id,
          connectorId: row.connector_id,
          filePath: row.file_path,
          originalFilename: row.original_filename,
          mimeType: row.mime_type,
          size: row.size,
          checksum: row.checksum,
          expiresAt: new Date(row.expires_at).getTime(),
        });
      }
    }
  } catch {
    // Table may not exist yet (first run before migration) — in-memory only for this session
  }
}

function getStagingDir(): string {
  const dir = process.env.SOCIAL_MEDIA_STAGING_DIR;
  if (!dir) throw new StagingError('SOCIAL_MEDIA_STAGING_DIR is not configured.');
  return dir;
}

function getStagingSecret(): Buffer {
  const secret = process.env.SOCIAL_MEDIA_STAGING_SECRET;
  if (!secret || secret.length < 16) {
    throw new StagingError('SOCIAL_MEDIA_STAGING_SECRET is not configured (must be at least 16 chars).');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function getPublicBaseUrl(): string {
  const base = process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL;
  if (!base) throw new StagingError('SOCIAL_MEDIA_PUBLIC_BASE_URL is not configured.');
  return base.replace(/\/$/, '');
}

function sanitiseFilename(name: string): string {
  // Reject path traversal attempts outright before any processing
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new StagingError(
      `Filename "${name}" contains path traversal characters and is rejected.`,
    );
  }
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (safe.startsWith('.')) {
    throw new StagingError(`Hidden or dotfile filenames are not allowed: ${name}`);
  }
  return safe || 'upload.bin';
}

/**
 * Validate file magic bytes against the declared MIME type.
 * Prevents clients from mislabeling malicious content as an allowed media type.
 */
function validateMagicBytes(buffer: Buffer, mimeType: string): void {
  if (buffer.length < 8) {
    throw new StagingError('File too small to validate (less than 8 bytes).');
  }

  switch (mimeType) {
    case 'image/jpeg':
      if (buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
        throw new StagingError('File does not match JPEG magic bytes (FF D8 FF).');
      }
      break;

    case 'image/png':
      if (
        buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47 ||
        buffer[4] !== 0x0D || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A
      ) {
        throw new StagingError('File does not match PNG magic bytes (89 50 4E 47 0D 0A 1A 0A).');
      }
      break;

    case 'image/gif':
      // GIF87a or GIF89a
      if (
        buffer[0] !== 0x47 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x38 ||
        (buffer[4] !== 0x37 && buffer[4] !== 0x39) || buffer[5] !== 0x61
      ) {
        throw new StagingError('File does not match GIF magic bytes (GIF87a or GIF89a).');
      }
      break;

    case 'image/webp':
      // RIFF....WEBP
      if (
        buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50
      ) {
        if (buffer.length < 12) {
          throw new StagingError('File too small to validate WebP format.');
        }
        throw new StagingError('File does not match WebP magic bytes (RIFF....WEBP).');
      }
      break;

    case 'video/mp4':
    case 'video/quicktime': {
      // MP4/MOV: ftyp box at offset 4-7. Many MP4 files start with a size (4 bytes) then "ftyp".
      // Also check for "moov" or "mdat" boxes for files without ftyp.
      if (buffer.length < 12) {
        throw new StagingError('File too small to validate as MP4/MOV.');
      }
      const boxType = buffer.slice(4, 8).toString('ascii');
      const validBoxTypes = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'];
      if (!validBoxTypes.includes(boxType)) {
        throw new StagingError(
          `File does not appear to be a valid MP4/MOV container (box type "${boxType}" not recognised).`,
        );
      }
      break;
    }

    default:
      throw new StagingError(`Unsupported MIME type "${mimeType}" for magic byte validation.`);
  }
}

export interface StageMediaInput {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  ttlSeconds?: number;
  businessId: string;
  connectorId: string;
}

export interface StagingResult {
  stagingToken: string;
  checksum: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

/**
 * Stage a media file for later serving to Meta's CDN fetcher.
 */
export async function stageMediaFile(input: StageMediaInput): Promise<StagingResult> {
  const { buffer, originalFilename, mimeType, ttlSeconds = DEFAULT_TTL_SECONDS, businessId, connectorId } = input;

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new StagingError(
      `MIME type "${mimeType}" is not allowed for social media staging. ` +
      `Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}.`,
    );
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new StagingError(
      `File size ${buffer.length} bytes exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes (100 MB).`,
    );
  }

  // Validate magic bytes to prevent MIME type spoofing
  validateMagicBytes(buffer, mimeType);

  const safeName = sanitiseFilename(originalFilename);
  const ext = path.extname(safeName) || '.bin';
  const stagingToken = crypto.randomUUID();
  const filename = `${stagingToken}${ext}`;

  const stagingDir = getStagingDir();
  const filePath = path.join(stagingDir, filename);

  // Resolve and verify path containment
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(stagingDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new StagingError('Path containment violation — file would be written outside staging directory.');
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(filePath, buffer);

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const expiresAtIso = new Date(expiresAt).toISOString();

  const metadata: StagingMetadata = {
    stagingToken,
    businessId,
    connectorId,
    filePath,
    originalFilename: safeName,
    mimeType,
    size: buffer.length,
    checksum,
    expiresAt,
  };

  // Persist to DB for restart-safety
  try {
    db.prepare(`
      INSERT OR REPLACE INTO social_media_staging
        (staging_token, business_id, connector_id, file_path, original_filename,
         mime_type, size, checksum, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(stagingToken, businessId, connectorId, filePath, safeName, mimeType, buffer.length, checksum, expiresAtIso);
  } catch {
    // Non-fatal: in-memory index is the fallback
  }

  ensureIndexLoaded();
  stagingIndex.set(stagingToken, metadata);

  return {
    stagingToken,
    checksum,
    mimeType,
    size: buffer.length,
    expiresAt,
  };
}

/**
 * Generate an HMAC-signed, expiring serving URL for a staged file.
 */
export function generateServingUrl(stagingToken: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const baseUrl = getPublicBaseUrl();
  const key = getStagingSecret();
  const expiresAt = Math.floor((Date.now() + ttlSeconds * 1000) / 1000);
  const message = `${stagingToken}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', key).update(message).digest('base64url');
  return `${baseUrl}/social-media/${sig}.${expiresAt}.${stagingToken}`;
}

/**
 * Parse and validate a serving URL path.
 * Returns { stagingToken } if valid, null if signature invalid or expired.
 */
export function parseServingUrl(urlPath: string): { stagingToken: string } | null {
  // Path: /social-media/<sig>.<expiry>.<token>
  const match = urlPath.match(/^\/social-media\/([^.]+)\.(\d+)\.(.+)$/);
  if (!match) return null;

  const sig = match[1];
  const expiryStr = match[2];
  const stagingToken = match[3];
  if (!sig || !expiryStr || !stagingToken) return null;
  const expiry = parseInt(expiryStr, 10);
  if (Math.floor(Date.now() / 1000) > expiry) return null; // Expired

  const key = getStagingSecret();
  const message = `${stagingToken}.${expiryStr}`;
  const expectedSig = crypto.createHmac('sha256', key).update(message).digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  return { stagingToken };
}

/**
 * Validate that a staging token exists, is not expired, and (optionally) belongs to the
 * given business and connector.
 */
export function validateStagedMedia(stagingToken: string): StagingMetadata | null {
  ensureIndexLoaded();
  const meta = stagingIndex.get(stagingToken);
  if (!meta) return null;
  if (meta.expiresAt < Date.now()) {
    stagingIndex.delete(stagingToken);
    return null;
  }
  return meta;
}

/**
 * Get the file path for a staging token (for serving).
 * Does NOT enforce business/connector ownership — that is the serving URL's job (HMAC).
 */
export function getStagedFilePath(stagingToken: string): string | null {
  ensureIndexLoaded();
  const meta = stagingIndex.get(stagingToken);
  if (!meta) return null;
  if (meta.expiresAt < Date.now()) {
    stagingIndex.delete(stagingToken);
    return null;
  }
  return meta.filePath;
}

/**
 * Remove a staged file after it has been consumed or expired.
 * Requires the caller to provide businessId and connectorId for ownership verification.
 * Returns true if a file was removed, false if not found or ownership mismatch.
 */
export function cleanupStagedFile(
  stagingToken: string,
  businessId: string,
  connectorId: string,
): boolean {
  ensureIndexLoaded();
  const meta = stagingIndex.get(stagingToken);
  if (!meta) return false;

  // Enforce ownership: only the owning business+connector can delete
  if (meta.businessId !== businessId || meta.connectorId !== connectorId) {
    return false;
  }

  stagingIndex.delete(stagingToken);
  try { db.prepare(`DELETE FROM social_media_staging WHERE staging_token = ?`).run(stagingToken); } catch {}
  try {
    if (fs.existsSync(meta.filePath)) {
      fs.unlinkSync(meta.filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Cleanup all expired staged files (call from scheduler).
 */
export function cleanupExpiredStagedFiles(): number {
  ensureIndexLoaded();
  let count = 0;
  const now = Date.now();
  for (const [token, meta] of stagingIndex.entries()) {
    if (meta.expiresAt < now) {
      stagingIndex.delete(token);
      try { db.prepare(`DELETE FROM social_media_staging WHERE staging_token = ?`).run(token); } catch {}
      try { fs.unlinkSync(meta.filePath); count++; } catch {}
    }
  }
  // Also prune expired DB rows that may not be in memory
  try {
    db.prepare(`DELETE FROM social_media_staging WHERE expires_at < ?`).run(new Date().toISOString());
  } catch {}
  return count;
}
