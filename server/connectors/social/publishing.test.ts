/**
 * TDD tests for the social publishing domain.
 * Uses mocked Graph API responses — no real Meta calls.
 */
import { describe, test, expect, mock, beforeAll } from 'bun:test';
// Required by GraphClient
process.env.META_APP_ID = 'test_app_123';
process.env.META_APP_SECRET = 'test_secret';

import db from '../../db/db.js';
import {
  createDraft,
  approveDraft,
  cancelPost,
  getPost,
  listPosts,
  publishNow,
  SocialPublishingError,
  type CreateDraftInput,
  type SocialPostRecord,
} from './publishing.js';

// Standard test binding IDs — used across all publishNow tests
const FB_PAGE_ID = 'page_123';
const IG_ACCOUNT_ID = 'ig_account_999';
const BOUND_CONFIG = JSON.stringify({ facebookPageId: FB_PAGE_ID, instagramAccountId: IG_ACCOUNT_ID });

/** Helper to rebind the test connector to a specific targetId for a given platform. */
function rebindConnector(facebookPageId: string, instagramAccountId: string): void {
  db.prepare(`UPDATE connectors SET config = ? WHERE id = 'conn_pub_test'`)
    .run(JSON.stringify({ facebookPageId, instagramAccountId }));
}

// Ensure test businesses and connectors exist, with bound accounts pre-configured
beforeAll(() => {
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES ('biz_pub_test', 'Pub Test', 'pub-test')`).run();
  db.prepare(`INSERT OR IGNORE INTO businesses (id, name, slug) VALUES ('biz_pub_other', 'Pub Other', 'pub-other')`).run();
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES ('conn_pub_test', 'biz_pub_test', 'social', 'Facebook & Instagram', '{}', 'connected', ?)
  `).run(BOUND_CONFIG);
  // Set the binding even if the row already existed
  db.prepare(`UPDATE connectors SET config = ? WHERE id = 'conn_pub_test'`).run(BOUND_CONFIG);
  db.prepare(`
    INSERT OR IGNORE INTO connectors (id, business_id, type, name, credentials, status, config)
    VALUES ('conn_pub_other', 'biz_pub_other', 'social', 'Facebook & Instagram', '{}', 'connected', '{}')
  `).run();
});

const validDraftFb: CreateDraftInput = {
  businessId: 'biz_pub_test',
  connectorId: 'conn_pub_test',
  platform: 'facebook',
  targetId: 'page_123',
  contentType: 'text',
  caption: 'Hello World from Blueprint!',
  mediaUrls: [],
};

describe('createDraft', () => {
  test('creates a draft post in the database', async () => {
    const post = await createDraft(validDraftFb);
    expect(post.id).toBeTruthy();
    expect(post.status).toBe('draft');
    expect(post.platform).toBe('facebook');
    expect(post.businessId).toBe('biz_pub_test');
    expect(post.caption).toBe('Hello World from Blueprint!');
  });

  test('new draft defaults to requires_approval mode', async () => {
    const post = await createDraft(validDraftFb);
    expect(post.approvalMode).toBe('requires_approval');
  });

  test('rejects empty caption for text posts', async () => {
    await expect(createDraft({ ...validDraftFb, caption: '' }))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('rejects caption over 63206 characters (FB limit)', async () => {
    await expect(createDraft({ ...validDraftFb, caption: 'x'.repeat(63207) }))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('rejects Instagram post with contentType requiring unsupported media', async () => {
    await expect(createDraft({
      ...validDraftFb,
      platform: 'instagram',
      contentType: 'text', // Instagram requires media
    })).rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('rejects unknown platform', async () => {
    await expect(createDraft({ ...validDraftFb, platform: 'tiktok' as any }))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('rejects missing targetId', async () => {
    await expect(createDraft({ ...validDraftFb, targetId: '' }))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('creates draft with scheduled time', async () => {
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    const post = await createDraft({ ...validDraftFb, scheduledAt });
    expect(post.status).toBe('draft');
    expect(post.scheduledAt).toBe(scheduledAt);
  });

  test('rejects schedule time in the past', async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    await expect(createDraft({ ...validDraftFb, scheduledAt: pastTime }))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });
});

describe('approveDraft', () => {
  test('moves post from draft to approved', async () => {
    const post = await createDraft(validDraftFb);
    const approved = await approveDraft(post.id, 'biz_pub_test', 'user_approver');
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('user_approver');
    expect(approved.approvedAt).toBeTruthy();
  });

  test('captures the approved caption revision at approval time', async () => {
    const post = await createDraft(validDraftFb);
    const approved = await approveDraft(post.id, 'biz_pub_test', 'user_approver');
    expect(approved.approvedCaption).toBe(post.caption);
  });

  test('cannot approve a non-draft post', async () => {
    const post = await createDraft(validDraftFb);
    await approveDraft(post.id, 'biz_pub_test', 'user_approver');
    // Second approve fails (already approved, not draft)
    await expect(approveDraft(post.id, 'biz_pub_test', 'user_approver'))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('cross-business access is rejected (tenant isolation)', async () => {
    const post = await createDraft(validDraftFb);
    await expect(approveDraft(post.id, 'biz_pub_other', 'user_other'))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('approving unknown post ID throws SocialPublishingError', async () => {
    await expect(approveDraft('nonexistent_post_id', 'biz_pub_test', 'user'))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });
});

describe('cancelPost', () => {
  test('cancels a draft post', async () => {
    const post = await createDraft(validDraftFb);
    const cancelled = await cancelPost(post.id, 'biz_pub_test', 'user_canceller');
    expect(cancelled.status).toBe('cancelled');
  });

  test('cancels an approved post', async () => {
    const post = await createDraft(validDraftFb);
    await approveDraft(post.id, 'biz_pub_test', 'user_approver');
    const cancelled = await cancelPost(post.id, 'biz_pub_test', 'user_canceller');
    expect(cancelled.status).toBe('cancelled');
  });

  test('cannot cancel an already-published post', async () => {
    // Simulate published via direct DB update
    const post = await createDraft(validDraftFb);
    db.prepare(`UPDATE social_posts SET status = 'published' WHERE id = ?`).run(post.id);
    await expect(cancelPost(post.id, 'biz_pub_test', 'user'))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('cross-business cancel is rejected', async () => {
    const post = await createDraft(validDraftFb);
    await expect(cancelPost(post.id, 'biz_pub_other', 'user_other'))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });
});

describe('getPost / listPosts', () => {
  test('getPost returns the post for the correct business', async () => {
    const post = await createDraft(validDraftFb);
    const fetched = await getPost(post.id, 'biz_pub_test');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(post.id);
  });

  test('getPost returns null for wrong business (tenant isolation)', async () => {
    const post = await createDraft(validDraftFb);
    const fetched = await getPost(post.id, 'biz_pub_other');
    expect(fetched).toBeNull();
  });

  test('listPosts returns only posts for the specified business', async () => {
    // Create one for each business
    await createDraft(validDraftFb);
    await createDraft({ ...validDraftFb, businessId: 'biz_pub_other', connectorId: 'conn_pub_other' });

    const listA = await listPosts('biz_pub_test', {});
    const listB = await listPosts('biz_pub_other', {});

    expect(listA.every(p => p.businessId === 'biz_pub_test')).toBe(true);
    expect(listB.every(p => p.businessId === 'biz_pub_other')).toBe(true);
  });

  test('listPosts filters by status', async () => {
    const post = await createDraft(validDraftFb);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    const drafts = await listPosts('biz_pub_test', { status: 'draft' });
    const approved = await listPosts('biz_pub_test', { status: 'approved' });

    expect(drafts.every(p => p.status === 'draft')).toBe(true);
    expect(approved.some(p => p.status === 'approved')).toBe(true);
  });
});

describe('publishNow - mocked Meta responses', () => {
  const mockSuccessIG = {
    containerResponse: { id: 'ig_container_123' },
    statusResponse: { status_code: 'FINISHED' },
    publishResponse: { id: 'ig_post_456' },
    readbackResponse: { id: 'ig_post_456', permalink: 'https://www.instagram.com/p/abc123/', timestamp: '2025-01-01T12:00:00Z' },
  };

  test('IG post: published status requires successful readback, not just publish response', async () => {
    const igDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'instagram',
      targetId: IG_ACCOUNT_ID, // Must match bound instagramAccountId
      contentType: 'image',
      caption: 'Test IG post',
      mediaUrls: ['https://example.com/image.jpg'],
    };
    const post = await createDraft(igDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    let fetchCallCount = 0;
    const mockFetch = mock(async (url: string) => {
      fetchCallCount++;
      const urlStr = String(url);
      if (urlStr.includes('/media_publish')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ig_post_456' }) };
      }
      if (urlStr.endsWith('/media')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ig_container_123' }) };
      }
      if (urlStr.includes('status_code')) {
        return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
      }
      if (urlStr.includes('ig_post_456')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'ig_post_456',
          permalink: 'https://www.instagram.com/p/abc123/',
          timestamp: '2025-01-01T12:00:00Z',
        })};
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
    });

    expect(result.status).toBe('published');
    expect(result.externalId).toBe('ig_post_456');
    expect(result.permalink).toContain('instagram.com');
    expect(result.verifiedAt).toBeTruthy();
  });

  test('IG post: container ERROR status leads to failed, not published', async () => {
    const igDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'instagram',
      targetId: IG_ACCOUNT_ID, // Must match bound instagramAccountId
      contentType: 'image',
      caption: 'Test IG post failure',
      mediaUrls: ['https://example.com/image.jpg'],
    };
    const post = await createDraft(igDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    const mockFetch = mock(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/media')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ig_container_fail' }) };
      }
      if (urlStr.includes('status_code')) {
        return { ok: true, status: 200, json: async () => ({
          status_code: 'ERROR',
          status: 'Some encoding error',
        })};
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
    });
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('ERROR');
  });

  test('FB post: published requires readback permalink', async () => {
    const fbDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'facebook',
      targetId: FB_PAGE_ID, // Must match bound facebookPageId
      contentType: 'text',
      caption: 'Hello from Blueprint!',
      mediaUrls: [],
    };
    const post = await createDraft(fbDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    const mockFetch = mock(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/feed')) {
        return { ok: true, status: 200, json: async () => ({ id: 'page_post_111' }) };
      }
      if (urlStr.includes('page_post_111')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'page_post_111',
          permalink_url: 'https://www.facebook.com/permalink/111',
          created_time: '2025-01-01T12:00:00Z',
        })};
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
    });
    expect(result.status).toBe('published');
    expect(result.externalId).toBe('page_post_111');
    expect(result.permalink).toContain('facebook.com');
  });

  test('only approved posts can be published', async () => {
    const post = await createDraft(validDraftFb);
    // Don't approve — try to publish directly
    await expect(publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {}))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });

  test('target binding enforcement: wrong targetId causes permanent failure', async () => {
    const fbDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'facebook',
      targetId: 'some_other_page_not_bound', // Not the bound page
      contentType: 'text',
      caption: 'Should be blocked',
      mediaUrls: [],
    };
    const post = await createDraft(fbDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {});
    // Should fail because targetId doesn't match bound facebookPageId
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('does not match the bound Facebook Page');
  });

  test('duplicate publish attempt returns existing published record (idempotency)', async () => {
    const fbDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'facebook',
      targetId: FB_PAGE_ID, // Must match bound facebookPageId
      contentType: 'text',
      caption: 'Dedup test',
      mediaUrls: [],
    };
    const post = await createDraft(fbDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    // Simulate the post being already published
    db.prepare(`UPDATE social_posts SET status = 'published', external_id = 'existing_ext_123' WHERE id = ?`).run(post.id);

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {});
    expect(result.status).toBe('published');
    expect(result.externalId).toBe('existing_ext_123');
  });
});

describe('retry and error classification', () => {
  test('429 from Meta is treated as transient (retryable)', async () => {
    const { isRetryable } = await import('./publishing.js');
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  test('400 from Meta is treated as permanent (not retryable)', async () => {
    const { isRetryable } = await import('./publishing.js');
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(403)).toBe(false);
  });
});

describe('publishNow - IG carousel flow', () => {
  test('IG carousel: creates child containers then parent, publishes and reads back permalink', async () => {
    const carouselDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'instagram',
      targetId: IG_ACCOUNT_ID, // Must match bound instagramAccountId
      contentType: 'carousel',
      caption: 'My carousel post',
      mediaUrls: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
    };
    const post = await createDraft(carouselDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    let containerCallCount = 0;
    const mockFetch = mock(async (url: string) => {
      const urlStr = String(url);
      // media_publish must be checked before /media (substring match)
      if (urlStr.includes('/media_publish')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ig_carousel_post_789' }) };
      }
      if (urlStr.includes('ig_carousel_post_789')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'ig_carousel_post_789',
          permalink: 'https://www.instagram.com/p/carousel123/',
          timestamp: '2025-01-01T12:00:00Z',
        })};
      }
      if (urlStr.includes('status_code')) {
        return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
      }
      if (urlStr.endsWith('/media')) {
        containerCallCount++;
        return { ok: true, status: 200, json: async () => ({ id: `ig_container_${containerCallCount}` }) };
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
      maxContainerPollAttempts: 1,
    });

    expect(result.status).toBe('published');
    expect(result.permalink).toContain('instagram.com');
    expect(result.externalId).toBe('ig_carousel_post_789');
    // 2 child containers + 1 parent = 3 container creation calls
    expect(containerCallCount).toBe(3);
  });

  test('IG carousel: validates min 2 mediaUrls', async () => {
    await expect(createDraft({
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'instagram',
      targetId: IG_ACCOUNT_ID,
      contentType: 'carousel',
      caption: 'Single image carousel',
      mediaUrls: ['https://example.com/img1.jpg'],
    })).rejects.toBeInstanceOf(SocialPublishingError);
  });
});

describe('publishNow - FB photo flows', () => {
  test('FB image: uses /photos endpoint (not /feed) and gets permalink', async () => {
    const fbImageDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'facebook',
      targetId: FB_PAGE_ID, // Must match bound facebookPageId
      contentType: 'image',
      caption: 'Check out this photo!',
      mediaUrls: ['https://example.com/photo.jpg'],
    };
    const post = await createDraft(fbImageDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    let usedPhotosEndpoint = false;
    let usedFeedEndpoint = false;
    const mockFetch = mock(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/photos')) {
        usedPhotosEndpoint = true;
        return { ok: true, status: 200, json: async () => ({ id: 'photo_123', post_id: 'page_fb_img_post_456' }) };
      }
      if (urlStr.includes('/feed')) {
        usedFeedEndpoint = true;
        return { ok: true, status: 200, json: async () => ({ id: 'feed_post' }) };
      }
      if (urlStr.includes('page_fb_img_post_456')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'page_fb_img_post_456',
          permalink_url: 'https://www.facebook.com/photo/456',
          created_time: '2025-01-01T12:00:00Z',
        })};
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
    });
    expect(result.status).toBe('published');
    expect(result.permalink).toContain('facebook.com');
    expect(usedPhotosEndpoint).toBe(true);
    expect(usedFeedEndpoint).toBe(false);
  });

  test('FB multi_image: creates unpublished photos then posts feed with attached_media', async () => {
    const fbMultiDraft: CreateDraftInput = {
      businessId: 'biz_pub_test',
      connectorId: 'conn_pub_test',
      platform: 'facebook',
      targetId: FB_PAGE_ID, // Must match bound facebookPageId
      contentType: 'multi_image',
      caption: 'Multiple photos!',
      mediaUrls: ['https://example.com/photo1.jpg', 'https://example.com/photo2.jpg'],
    };
    const post = await createDraft(fbMultiDraft);
    await approveDraft(post.id, 'biz_pub_test', 'user');

    let photoCount = 0;
    let feedCallBody: string | undefined;
    const mockFetch = mock(async (url: string, options?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/photos')) {
        photoCount++;
        return { ok: true, status: 200, json: async () => ({ id: `photo_${photoCount}` }) };
      }
      // Check readback URL before /feed check because '/feed_post_789' contains '/feed' as substring
      if (urlStr.includes('feed_post_789')) {
        return { ok: true, status: 200, json: async () => ({
          id: 'feed_post_789',
          permalink_url: 'https://www.facebook.com/permalink/789',
          created_time: '2025-01-01T12:00:00Z',
        })};
      }
      if (urlStr.includes('/feed')) {
        feedCallBody = options?.body;
        return { ok: true, status: 200, json: async () => ({ id: 'feed_post_789' }) };
      }
      return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
    });

    const result = await publishNow(post.id, 'biz_pub_test', 'EAA_mock_token', {
      fetchFn: mockFetch as any,
    });
    expect(result.status).toBe('published');
    expect(result.permalink).toContain('facebook.com');
    // Both images should have been uploaded as unpublished photos
    expect(photoCount).toBe(2);
    // Feed post should include attached_media referencing the photo IDs
    expect(feedCallBody).toBeDefined();
    const parsedBody = JSON.parse(feedCallBody!);
    expect(parsedBody.attached_media).toContain('photo_1');
    expect(parsedBody.attached_media).toContain('photo_2');
  });
});

describe('identity validation before publish', () => {
  test('publishNow rejects post when businessId does not match the post', async () => {
    const post = await createDraft(validDraftFb);
    await approveDraft(post.id, 'biz_pub_test', 'user');
    // Attempt to publish as a different business — should throw because post not found for that business
    await expect(publishNow(post.id, 'biz_pub_other', 'EAA_mock_token', {}))
      .rejects.toBeInstanceOf(SocialPublishingError);
  });
});
