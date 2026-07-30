/**
 * TDD tests for media staging subsystem.
 * Covers MIME validation (including magic bytes), path containment, URL signing, and ownership.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Set up a temp staging dir and required env vars
const STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-staging-test-'));
process.env.SOCIAL_MEDIA_STAGING_DIR = STAGING_DIR;
process.env.SOCIAL_MEDIA_STAGING_SECRET = 'test_staging_secret_32_bytes_xxxxx';
process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL = 'https://example.com';
process.env.DATABASE_PATH = ':memory:';

import {
  stageMediaFile,
  validateStagedMedia,
  generateServingUrl,
  parseServingUrl,
  StagingError,
  cleanupStagedFile,
} from './media-staging.js';

afterAll(() => {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
});

// Valid 1×1 PNG (magic bytes: 89 50 4E 47 0D 0A 1A 0A)
const SMALL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000' +
  '0a49444154789c6260000000020001e221bc330000000049454e44ae426082',
  'hex',
);

// Valid JPEG header (magic bytes: FF D8 FF E0)
const SMALL_JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
  Buffer.alloc(20, 0x00), // filler bytes
]);

// Valid WebP header (RIFF....WEBP)
const SMALL_WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
  Buffer.from([0x10, 0x00, 0x00, 0x00]), // file size (little-endian)
  Buffer.from([0x57, 0x45, 0x42, 0x50]), // WEBP
]);

const TEST_OWNER = { businessId: 'biz_staging_test', connectorId: 'conn_staging_test' };

describe('stageMediaFile', () => {
  test('stages a valid PNG and returns a staging token', async () => {
    const result = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'test.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    expect(result.stagingToken).toBeTruthy();
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mimeType).toBe('image/png');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    const files = fs.readdirSync(STAGING_DIR);
    expect(files.length).toBeGreaterThan(0);
  });

  test('stages a valid JPEG', async () => {
    const result = await stageMediaFile({
      buffer: SMALL_JPEG,
      originalFilename: 'test.jpg',
      mimeType: 'image/jpeg',
      ...TEST_OWNER,
    });
    expect(result.stagingToken).toBeTruthy();
  });

  test('rejects MIME type not on the allowed list', async () => {
    await expect(stageMediaFile({
      buffer: Buffer.from('not a real file'),
      originalFilename: 'shell.sh',
      mimeType: 'text/x-shellscript',
      ...TEST_OWNER,
    })).rejects.toBeInstanceOf(StagingError);
  });

  test('rejects files that exceed max size', async () => {
    const huge = Buffer.alloc(110 * 1024 * 1024);
    await expect(stageMediaFile({
      buffer: huge,
      originalFilename: 'too_big.jpg',
      mimeType: 'image/jpeg',
      ...TEST_OWNER,
    })).rejects.toBeInstanceOf(StagingError);
  });

  test('rejects filenames with path traversal', async () => {
    await expect(stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: '../../etc/passwd.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    })).rejects.toBeInstanceOf(StagingError);
  });

  test('rejects PNG magic bytes mismatch (JPEG header labeled as PNG)', async () => {
    await expect(stageMediaFile({
      buffer: SMALL_JPEG,
      originalFilename: 'disguised.png',
      mimeType: 'image/png', // Wrong MIME for a JPEG buffer
      ...TEST_OWNER,
    })).rejects.toBeInstanceOf(StagingError);
  });

  test('rejects JPEG magic bytes mismatch (PNG data labeled as JPEG)', async () => {
    await expect(stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'disguised.jpg',
      mimeType: 'image/jpeg', // Wrong MIME for a PNG buffer
      ...TEST_OWNER,
    })).rejects.toBeInstanceOf(StagingError);
  });

  test('accepts valid WebP', async () => {
    const result = await stageMediaFile({
      buffer: SMALL_WEBP,
      originalFilename: 'test.webp',
      mimeType: 'image/webp',
      ...TEST_OWNER,
    });
    expect(result.stagingToken).toBeTruthy();
  });
});

describe('generateServingUrl / parseServingUrl', () => {
  test('round-trips correctly with unexpired URL', async () => {
    const { stagingToken } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'round-trip.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    const url = generateServingUrl(stagingToken);
    expect(url).toContain('https://example.com');

    const parsed = parseServingUrl(new URL(url).pathname);
    expect(parsed).not.toBeNull();
    expect(parsed!.stagingToken).toBe(stagingToken);
  });

  test('rejects tampered signature in URL', () => {
    const parsed = parseServingUrl('/social-media/fakesig.1234567890.abc');
    expect(parsed).toBeNull();
  });

  test('rejects expired URL', async () => {
    const { stagingToken } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'exp.png',
      mimeType: 'image/png',
      ttlSeconds: -1,
      ...TEST_OWNER,
    });
    const url = generateServingUrl(stagingToken, -1);
    const parsed = parseServingUrl(new URL(url).pathname);
    expect(parsed).toBeNull();
  });
});

describe('validateStagedMedia', () => {
  test('returns metadata for a valid staged token', async () => {
    const { stagingToken, checksum } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'validate.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    const meta = validateStagedMedia(stagingToken);
    expect(meta).not.toBeNull();
    expect(meta!.checksum).toBe(checksum);
    expect(meta!.mimeType).toBe('image/png');
  });

  test('returns null for unknown token', () => {
    const meta = validateStagedMedia('nonexistent_token_xyz');
    expect(meta).toBeNull();
  });
});

describe('cleanupStagedFile', () => {
  test('removes the staged file when ownership matches', async () => {
    const { stagingToken } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'cleanup.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    const removed = cleanupStagedFile(stagingToken, TEST_OWNER.businessId, TEST_OWNER.connectorId);
    expect(removed).toBe(true);
    expect(cleanupStagedFile(stagingToken, TEST_OWNER.businessId, TEST_OWNER.connectorId)).toBe(false);
  });

  test('rejects deletion when businessId does not match', async () => {
    const { stagingToken } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'cross-biz.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    const removed = cleanupStagedFile(stagingToken, 'other_business', TEST_OWNER.connectorId);
    expect(removed).toBe(false);
    // Original should still exist
    expect(validateStagedMedia(stagingToken)).not.toBeNull();
  });

  test('rejects deletion when connectorId does not match', async () => {
    const { stagingToken } = await stageMediaFile({
      buffer: SMALL_PNG,
      originalFilename: 'cross-conn.png',
      mimeType: 'image/png',
      ...TEST_OWNER,
    });
    const removed = cleanupStagedFile(stagingToken, TEST_OWNER.businessId, 'other_connector');
    expect(removed).toBe(false);
    expect(validateStagedMedia(stagingToken)).not.toBeNull();
  });
});
