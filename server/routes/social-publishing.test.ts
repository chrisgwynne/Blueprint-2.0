/**
 * TDD tests for the social publishing REST API routes.
 * Tests: tenant isolation, auth, discovery, identity binding, approval flow,
 *        capabilities, policy CRUD, and account binding.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import db, { generateId } from '../db/db.js';
import { encrypt } from '../crypto.js';

process.env.META_APP_ID = 'test_app_social';
process.env.META_APP_SECRET = 'test_secret_social';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);

import socialPublishingRouter from './social-publishing.js';

const BIZ_A = 'biz_sp_test_a';
const BIZ_B = 'biz_sp_test_b';
const USER_A = 'user_sp_a';
const USER_B = 'user_sp_b';

let server: ReturnType<express.Express['listen']>;
let baseUrl: string;

function makeApp(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    (req.session as any).userId = userId;
    next();
  });
  app.use('/api/social-publishing', socialPublishingRouter);
  return app;
}

beforeAll(async () => {
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'SP Test A', 'sp-test-a')`).run(BIZ_A);
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'SP Test B', 'sp-test-b')`).run(BIZ_B);

  const creds = encrypt(JSON.stringify({
    access_token: 'EAA_test_social',
    token_expires_at: String(Date.now() + 86400_000),
    facebookPageId: 'page_sp_123',
    instagramAccountId: 'ig_sp_456',
  }));
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES ('conn_sp_a', ?, 'social', 'FB & IG', ?, 'connected', '{}')
  `).run(BIZ_A, creds);
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES ('conn_sp_b', ?, 'social', 'FB & IG', ?, 'connected', '{}')
  `).run(BIZ_B, creds);

  // Reset policy state so tests see the default regardless of prior runs
  db.prepare(`DELETE FROM settings WHERE key LIKE 'social_policy:conn_sp_%'`).run();

  const app = makeApp(USER_A);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function apiGet(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function apiPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('GET /api/social-publishing/:businessId/posts — tenant isolation', () => {
  test('lists posts for own business', async () => {
    const { status, body } = await apiGet(`/api/social-publishing/${BIZ_A}/posts`);
    expect(status).toBe(200);
    expect(Array.isArray(body.posts)).toBe(true);
  });

  test('401 without authentication', async () => {
    // Create a separate app with no session user
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
    noAuthApp.use('/api/social-publishing', socialPublishingRouter);

    const noAuthServer = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const s = noAuthApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const noAuthAddr = noAuthServer.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${noAuthAddr.port}/api/social-publishing/${BIZ_A}/posts`);
    await new Promise((r) => noAuthServer.close(r));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/social-publishing/:businessId/posts — create draft', () => {
  test('creates a draft post', async () => {
    const { status, body } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_a',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Hello from Blueprint tests!',
      mediaUrls: [],
    });
    expect(status).toBe(201);
    expect(body.post.status).toBe('draft');
    expect(body.post.businessId).toBe(BIZ_A);
  });

  test('rejects empty caption', async () => {
    const { status } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_a',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: '',
      mediaUrls: [],
    });
    expect(status).toBe(400);
  });

  test('rejects unknown connector that does not belong to this business', async () => {
    const { status } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_b', // Belongs to BIZ_B
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Cross-business attack!',
      mediaUrls: [],
    });
    expect(status).toBe(403);
  });

  test('rejects connector not of type "social"', async () => {
    db.prepare(`
      INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
      VALUES ('conn_sp_other_type', ?, 'ga4', 'GA4', '{}', 'connected', '{}')
    `).run(BIZ_A);

    const { status } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_other_type',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Wrong connector type',
      mediaUrls: [],
    });
    expect(status).toBe(403);
  });
});

describe('POST /api/social-publishing/:businessId/posts/:id/approve', () => {
  test('approves a draft post', async () => {
    const { body: createBody } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_a',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Post to approve',
      mediaUrls: [],
    });
    const postId = createBody.post.id;

    const { status, body } = await apiPost(
      `/api/social-publishing/${BIZ_A}/posts/${postId}/approve`,
      {},
    );
    expect(status).toBe(200);
    expect(body.post.status).toBe('approved');
    expect(body.post.approvedBy).toBe(USER_A);
  });

  test('cannot approve post belonging to another business', async () => {
    const { body: createBody } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_a',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Cross biz approve attempt',
      mediaUrls: [],
    });
    const postId = createBody.post.id;

    // Try to approve it for BIZ_B (should fail — wrong business)
    const { status } = await apiPost(
      `/api/social-publishing/${BIZ_B}/posts/${postId}/approve`,
      {},
    );
    expect(status).toBe(404);
  });
});

describe('POST /api/social-publishing/:businessId/posts/:id/cancel', () => {
  test('cancels a draft post', async () => {
    const { body: createBody } = await apiPost(`/api/social-publishing/${BIZ_A}/posts`, {
      connectorId: 'conn_sp_a',
      platform: 'facebook',
      targetId: 'page_sp_123',
      contentType: 'text',
      caption: 'Post to cancel',
      mediaUrls: [],
    });
    const { status, body } = await apiPost(
      `/api/social-publishing/${BIZ_A}/posts/${createBody.post.id}/cancel`,
      {},
    );
    expect(status).toBe(200);
    expect(body.post.status).toBe('cancelled');
  });
});

describe('GET /api/social-publishing/:businessId/accounts', () => {
  test('returns empty accounts when config is missing', async () => {
    const { status, body } = await apiGet(`/api/social-publishing/${BIZ_A}/accounts`);
    expect(status).toBe(200);
    expect(body.facebookPageId).toBeDefined();
    expect(body.instagramAccountId).toBeDefined();
  });
});

describe('Config/preflight checks', () => {
  test('preflight returns not_configured when META_APP_ID is missing', async () => {
    const savedAppId = process.env.META_APP_ID;
    delete process.env.META_APP_ID;
    const { status, body } = await apiGet(`/api/social-publishing/${BIZ_A}/preflight`);
    expect(status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.issues.some((i: string) => /META_APP_ID/i.test(i))).toBe(true);
    process.env.META_APP_ID = savedAppId;
  });

  test('preflight returns not_configured when SOCIAL_REDIRECT_URI is http in production', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.META_APP_ID = 'app_123';
    process.env.META_APP_SECRET = 'secret_123';
    process.env.SOCIAL_REDIRECT_URI = 'http://my-site.com/api/oauth/social/callback';

    const { body } = await apiGet(`/api/social-publishing/${BIZ_A}/preflight`);
    expect(body.configured).toBe(false);
    expect(body.issues.some((i: string) => /https/i.test(i) || /redirect/i.test(i))).toBe(true);

    process.env.NODE_ENV = savedNodeEnv;
    delete process.env.SOCIAL_REDIRECT_URI;
  });
});

describe('GET /api/social-publishing/:businessId/capabilities', () => {
  test('returns capability declarations for facebook and instagram', async () => {
    const { status, body } = await apiGet(`/api/social-publishing/${BIZ_A}/capabilities`);
    expect(status).toBe(200);
    expect(body.facebook.supported).toBe(true);
    expect(body.facebook.contentTypes.text.supported).toBe(true);
    expect(body.facebook.contentTypes.video.supported).toBe(false);
    expect(body.instagram.supported).toBe(true);
    expect(body.instagram.contentTypes.image.supported).toBe(true);
    expect(body.instagram.contentTypes.carousel.supported).toBe(true);
    expect(body.instagram.contentTypes.story.supported).toBe(false);
    expect(Array.isArray(body.notes)).toBe(true);
  });
});

describe('GET + PUT /api/social-publishing/:businessId/policy', () => {
  test('returns default policy for connector', async () => {
    const { status, body } = await apiGet(
      `/api/social-publishing/${BIZ_A}/policy?connectorId=conn_sp_a`,
    );
    expect(status).toBe(200);
    expect(body.policy.mode).toBe('approval_required');
    expect(Array.isArray(body.policy.allowedPlatforms)).toBe(true);
  });

  test('400 when connectorId query param is missing', async () => {
    const { status } = await apiGet(`/api/social-publishing/${BIZ_A}/policy`);
    expect(status).toBe(400);
  });

  test('403 when connectorId belongs to a different business', async () => {
    const { status } = await apiGet(
      `/api/social-publishing/${BIZ_A}/policy?connectorId=conn_sp_b`,
    );
    expect(status).toBe(403);
  });

  test('PUT updates the policy', async () => {
    const res = await fetch(`${baseUrl}/api/social-publishing/${BIZ_A}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorId: 'conn_sp_a', mode: 'immediate', maxDailyPosts: 5 }),
    });
    const body = await res.json() as { policy: { mode: string; maxDailyPosts: number } };
    expect(res.status).toBe(200);
    expect(body.policy.mode).toBe('immediate');
    expect(body.policy.maxDailyPosts).toBe(5);
  });

  test('PUT rejects invalid mode', async () => {
    const res = await fetch(`${baseUrl}/api/social-publishing/${BIZ_A}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorId: 'conn_sp_a', mode: 'not_a_valid_mode' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/social-publishing/:businessId/accounts/discover — mocked Graph API', () => {
  test('404 when no social connector exists for business', async () => {
    const { status } = await apiGet(`/api/social-publishing/${BIZ_B}/accounts/discover?connectorId=conn_nonexistent`);
    expect(status).toBe(404);
  });

  test('400 when access token is missing from credentials', async () => {
    const emptyCreds = encrypt(JSON.stringify({}));
    db.prepare(`
      INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
      VALUES ('conn_sp_nocreds', ?, 'social', 'No Creds', ?, 'connected', '{}')
    `).run(BIZ_A, emptyCreds);

    const { status, body } = await apiGet(
      `/api/social-publishing/${BIZ_A}/accounts/discover?connectorId=conn_sp_nocreds`,
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/access token/i);
  });

  test('400 when access token is expired', async () => {
    const expiredCreds = encrypt(JSON.stringify({
      access_token: 'EAA_expired',
      token_expires_at: String(Date.now() - 1000), // expired
    }));
    db.prepare(`
      INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
      VALUES ('conn_sp_expired', ?, 'social', 'Expired', ?, 'connected', '{}')
    `).run(BIZ_A, expiredCreds);

    const { status, body } = await apiGet(
      `/api/social-publishing/${BIZ_A}/accounts/discover?connectorId=conn_sp_expired`,
    );
    expect(status).toBe(400);
    expect(body.code).toBe('TOKEN_EXPIRED');
  });
});

describe('POST /api/social-publishing/:businessId/accounts/bind', () => {
  test('400 when facebookPageId is missing', async () => {
    const { status, body } = await apiPost(
      `/api/social-publishing/${BIZ_A}/accounts/bind`,
      { connectorId: 'conn_sp_a' },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/facebookPageId/i);
  });

  test('403 when connectorId belongs to another business', async () => {
    const { status } = await apiPost(
      `/api/social-publishing/${BIZ_A}/accounts/bind`,
      { connectorId: 'conn_sp_b', facebookPageId: 'page_123' },
    );
    expect(status).toBe(403);
  });

  test('400 when connector is missing access token', async () => {
    const { status } = await apiPost(
      `/api/social-publishing/${BIZ_A}/accounts/bind`,
      { connectorId: 'conn_sp_nocreds', facebookPageId: 'page_123' },
    );
    expect(status).toBe(400);
  });
});

describe('Media staging upload', () => {
  const stagingDir = '/tmp/blueprint-test-staging-upload';

  beforeAll(() => {
    process.env.SOCIAL_MEDIA_STAGING_DIR = stagingDir;
    process.env.SOCIAL_MEDIA_STAGING_SECRET = 'test-staging-secret-32chars-padded!!';
    process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL = 'https://example.com';
  });

  test('POST /media/upload stages a valid base64-encoded file', async () => {
    const imageData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const b64 = imageData.toString('base64');

    const { status, body } = await apiPost(`/api/social-publishing/${BIZ_A}/media/upload`, {
      connectorId: 'conn_sp_a',
      filename: 'test-pixel.png',
      mimeType: 'image/png',
      data: b64,
    });

    expect(status).toBe(201);
    expect(typeof body.stagingToken).toBe('string');
    expect(body.stagingToken.length).toBeGreaterThan(0);
    expect(typeof body.servingUrl).toBe('string');
    expect(body.servingUrl).toContain('/social-media/');
    expect(typeof body.checksum).toBe('string');
    expect(body.mimeType).toBe('image/png');
    expect(body.size).toBeGreaterThan(0);
    expect(typeof body.expiresAt).toBe('number');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  test('POST /media/upload rejects wrong businessId (tenant isolation)', async () => {
    const b64 = Buffer.from('fake-image-data').toString('base64');

    // connectorId conn_sp_b belongs to BIZ_B, not BIZ_A
    const { status, body } = await apiPost(`/api/social-publishing/${BIZ_A}/media/upload`, {
      connectorId: 'conn_sp_b',
      filename: 'evil.png',
      mimeType: 'image/png',
      data: b64,
    });

    expect(status).toBe(403);
    expect(body.error).toMatch(/connector/i);
  });

  test('POST /media/upload rejects disallowed MIME type', async () => {
    const b64 = Buffer.from('<html>evil</html>').toString('base64');

    const { status, body } = await apiPost(`/api/social-publishing/${BIZ_A}/media/upload`, {
      connectorId: 'conn_sp_a',
      filename: 'evil.html',
      mimeType: 'text/html',
      data: b64,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/mime type/i);
  });

  test('DELETE /media/:token removes staged file', async () => {
    // First stage a file to get a token
    const b64 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const { body: uploadBody } = await apiPost(`/api/social-publishing/${BIZ_A}/media/upload`, {
      connectorId: 'conn_sp_a',
      filename: 'to-delete.png',
      mimeType: 'image/png',
      data: b64,
    });
    const token = uploadBody.stagingToken as string;
    expect(typeof token).toBe('string');

    // Now delete it
    const res = await fetch(
      `${baseUrl}/api/social-publishing/${BIZ_A}/media/${token}?connectorId=conn_sp_a`,
      { method: 'DELETE' },
    );
    const body = await res.json() as { removed: boolean };
    expect(res.status).toBe(200);
    expect(body.removed).toBe(true);

    // Deleting again should return removed: false
    const res2 = await fetch(
      `${baseUrl}/api/social-publishing/${BIZ_A}/media/${token}?connectorId=conn_sp_a`,
      { method: 'DELETE' },
    );
    const body2 = await res2.json() as { removed: boolean };
    expect(res2.status).toBe(200);
    expect(body2.removed).toBe(false);
  });
});
