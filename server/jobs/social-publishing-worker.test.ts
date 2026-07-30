/**
 * TDD tests for the social publishing scheduled worker.
 * Uses direct SQL to set up post state — avoids domain-function validation
 * issues (e.g. createDraft's future-date check) when staging past-due posts.
 * No live Meta calls — worker is tested at the DB state machine level.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { encrypt } from '../crypto.js';
import { runSocialPublishingWorkerTick } from './social-publishing-worker.js';

process.env.META_APP_ID = 'test_spw_app';
process.env.META_APP_SECRET = 'test_spw_secret';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);

const BIZ = 'biz_spw_test';
const CONN = 'conn_spw_test';
const CONN_EXPIRED = 'conn_spw_expired';
const PAGE = 'page_spw_123';

const pastIso = new Date(Date.now() - 60_000).toISOString();
const futureIso = new Date(Date.now() + 3600_000).toISOString();

function insertApprovedPost(
  postId: string,
  connectorId: string,
  scheduledAt: string | null,
  attemptCount = 0,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO social_posts
      (id, business_id, connector_id, platform, target_id, content_type, caption,
       media_urls, status, approval_mode, approved_by, approved_at, approved_caption,
       scheduled_at, attempt_count, created_at, updated_at)
    VALUES (?, ?, ?, 'facebook', ?, 'text', 'Test caption', '[]',
            'approved', 'requires_approval', 'user_test', datetime('now'), 'Test caption',
            ?, ?, datetime('now'), datetime('now'))
  `).run(postId, BIZ, connectorId, PAGE, scheduledAt, attemptCount);
}

beforeAll(() => {
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES (?, 'SPW Test', 'spw-test')`).run(BIZ);

  const validCreds = encrypt(JSON.stringify({
    access_token: 'EAA_spw_valid',
    token_expires_at: String(Date.now() + 86400_000),
  }));
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES (?, ?, 'social', 'SPW Valid', ?, 'connected', '{}')
  `).run(CONN, BIZ, validCreds);

  const expiredCreds = encrypt(JSON.stringify({
    access_token: 'EAA_expired',
    token_expires_at: String(Date.now() - 1000),
  }));
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES (?, ?, 'social', 'SPW Expired', ?, 'connected', '{}')
  `).run(CONN_EXPIRED, BIZ, expiredCreds);

  // Ensure no leftover policy
  db.prepare(`DELETE FROM settings WHERE key LIKE 'social_policy:conn_spw%'`).run();
});

beforeEach(() => {
  // Clean up any posts from previous tests
  db.prepare(`DELETE FROM social_posts WHERE business_id = ?`).run(BIZ);
});

describe('No due posts', () => {
  test('returns 0 when social_posts table is empty', async () => {
    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0);
  });

  test('ignores posts with future scheduled_at', async () => {
    const postId = generateId();
    insertApprovedPost(postId, CONN, futureIso);
    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0);
  });

  test('ignores posts with no scheduled_at (not scheduled)', async () => {
    const postId = generateId();
    insertApprovedPost(postId, CONN, null);
    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0);
  });

  test('ignores posts that have hit MAX_ATTEMPTS', async () => {
    const postId = generateId();
    insertApprovedPost(postId, CONN, pastIso, 5); // attempt_count = MAX_ATTEMPTS
    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0);
  });
});

describe('No valid token', () => {
  test('marks post as failed and returns 1 when connector token is expired', async () => {
    const postId = generateId();
    insertApprovedPost(postId, CONN_EXPIRED, pastIso);

    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(1);

    const post = db.prepare(`SELECT status, last_error FROM social_posts WHERE id = ?`).get(postId) as any;
    expect(post.status).toBe('failed');
    expect(post.last_error).toMatch(/token/i);
  });
});

describe('Drafts-only policy', () => {
  test('marks post as failed when policy is drafts_only', async () => {
    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES ('social_policy:conn_spw_test',
              '{"mode":"drafts_only","allowedPlatforms":["facebook","instagram"],"allowedContentTypes":["text","image","carousel","video","reel","multi_image"],"maxDailyPosts":10,"maxWeeklyPosts":30}',
              CURRENT_TIMESTAMP)
    `).run();

    const postId = generateId();
    insertApprovedPost(postId, CONN, pastIso);

    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(1);

    const post = db.prepare(`SELECT status, last_error FROM social_posts WHERE id = ?`).get(postId) as any;
    expect(post.status).toBe('failed');
    expect(post.last_error).toMatch(/drafts_only/i);

    // Clean up policy
    db.prepare(`DELETE FROM settings WHERE key = 'social_policy:conn_spw_test'`).run();
  });
});

describe('Idempotency', () => {
  test('does not re-process an already-published post', async () => {
    const postId = generateId();
    db.prepare(`
      INSERT OR REPLACE INTO social_posts
        (id, business_id, connector_id, platform, target_id, content_type, caption,
         media_urls, status, approval_mode, external_id, permalink,
         scheduled_at, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, 'facebook', ?, 'text', 'Published', '[]',
              'published', 'requires_approval', 'ext_abc', 'https://fb.com/p/abc',
              ?, 1, datetime('now'), datetime('now'))
    `).run(postId, BIZ, CONN, PAGE, pastIso);

    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0); // published posts are not picked up (status != approved)

    const post = db.prepare(`SELECT status FROM social_posts WHERE id = ?`).get(postId) as any;
    expect(post.status).toBe('published'); // unchanged
  });

  test('atomic claim prevents double processing (concurrent-style)', async () => {
    const postId = generateId();
    insertApprovedPost(postId, CONN_EXPIRED, pastIso); // uses expired to prevent actual publish

    // Simulate two ticks racing: first tick claims it (changes status to publishing)
    db.prepare(`UPDATE social_posts SET status = 'publishing' WHERE id = ?`).run(postId);

    // Now findDuePosts should NOT return this post (status is publishing, not approved)
    const n = await runSocialPublishingWorkerTick();
    expect(n).toBe(0);
  });
});
