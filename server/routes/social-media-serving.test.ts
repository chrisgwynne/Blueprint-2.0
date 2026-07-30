/**
 * TDD tests for the public social-media serving endpoint.
 * Tests: valid URL returns 200, expired/tampered URL returns 404, unknown token 404.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';

const STAGING_DIR = '/tmp/blueprint-test-staging-serving';
const STAGING_SECRET = 'serving-test-secret-32chars-pad!!';
const PUBLIC_BASE_URL = 'http://127.0.0.1'; // port filled in below

// Must be set before importing the modules that read them at call time
process.env.SOCIAL_MEDIA_STAGING_DIR = STAGING_DIR;
process.env.SOCIAL_MEDIA_STAGING_SECRET = STAGING_SECRET;
// PUBLIC_BASE_URL will be set after we know the port

import socialMediaServingRouter from './social-media-serving.js';
import {
  stageMediaFile,
  generateServingUrl,
} from '../connectors/social/media-staging.js';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

// 1x1 transparent PNG (minimal valid PNG)
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const app = express();
  app.use('/social-media', socialMediaServingRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Set after port is known so generateServingUrl builds the right base
  process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL = baseUrl;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(STAGING_DIR, { recursive: true, force: true }); } catch {}
});

describe('GET /social-media/:filename — valid URL', () => {
  test('returns 200 with correct Content-Type for a staged file', async () => {
    const result = await stageMediaFile({
      buffer: PNG_PIXEL,
      originalFilename: 'pixel.png',
      mimeType: 'image/png',
    });
    const servingUrl = generateServingUrl(result.stagingToken);

    // The serving URL is absolute (e.g. http://127.0.0.1:<port>/social-media/<sig>.<exp>.<token>)
    // We need to fetch it from our test server, not the configured base URL
    const urlObj = new URL(servingUrl);
    const testUrl = `${baseUrl}${urlObj.pathname}`;

    const res = await fetch(testUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe('attachment');

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(PNG_PIXEL.length);
  });
});

describe('GET /social-media/:filename — invalid / expired URL', () => {
  test('returns 404 for a tampered signature', async () => {
    const result = await stageMediaFile({
      buffer: PNG_PIXEL,
      originalFilename: 'pixel2.png',
      mimeType: 'image/png',
    });
    const servingUrl = generateServingUrl(result.stagingToken);
    const urlObj = new URL(servingUrl);

    // Corrupt the first character of the sig component
    const parts = urlObj.pathname.split('/');
    // pathname: /social-media/<sig>.<exp>.<token>
    const filename = parts[parts.length - 1] as string;
    const tamperedFilename = 'X' + filename.slice(1); // flip first char
    const tamperedPath = urlObj.pathname.replace(filename, tamperedFilename);

    const res = await fetch(`${baseUrl}${tamperedPath}`);
    expect(res.status).toBe(404);
  });

  test('returns 404 for a completely unknown token (random path)', async () => {
    const res = await fetch(`${baseUrl}/social-media/AAAA.9999999999.00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  test('returns 404 for a path with no dots (malformed)', async () => {
    const res = await fetch(`${baseUrl}/social-media/no-dots-here`);
    expect(res.status).toBe(404);
  });
});
