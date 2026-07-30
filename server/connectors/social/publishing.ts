/**
 * Social publishing domain for Meta (Facebook + Instagram).
 *
 * State machine: draft → approved → [scheduled|publishing] → published | failed | cancelled
 *
 * Design principles:
 * - Approved posts have their caption snapshot captured at approval time (immutable)
 * - "Published" status only set after successful Meta readback verification
 * - Idempotent: duplicate publish calls on an already-published post return the existing record
 * - External ID is persisted before readback so a readback-only retry never re-creates the post
 * - Atomic publish claim: conditional UPDATE WHERE status='approved' prevents duplicate concurrent publishes
 * - Target binding revalidated against connector config before every publish
 * - Page access tokens used for Facebook Page publishing (stored in credentials during bind)
 * - Tenant isolation enforced at every operation
 * - 429/5xx errors are retryable; 4xx (except 429) are permanent failures
 */
import db, { generateId } from '../../db/db.js';
import nodeFetch from 'node-fetch';
import { GraphClient, GraphApiError } from './graph-client.js';

export class SocialPublishingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialPublishingError';
  }
}

const SUPPORTED_PLATFORMS = ['facebook', 'instagram'] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

const SUPPORTED_CONTENT_TYPES = {
  facebook: ['text', 'image', 'multi_image'] as const,
  instagram: ['image', 'carousel', 'video', 'reel'] as const,
};

const FB_CAPTION_MAX = 63206;
const IG_CAPTION_MAX = 2200;

type FetchFn = typeof nodeFetch;

export interface CreateDraftInput {
  businessId: string;
  connectorId: string;
  platform: string;
  targetId: string;
  contentType: string;
  caption: string;
  mediaUrls: string[];
  mediaAltText?: string;
  scheduledAt?: string;
}

export interface SocialPostRecord {
  id: string;
  businessId: string;
  connectorId: string;
  platform: string;
  targetId: string;
  contentType: string;
  caption: string;
  mediaUrls: string[];
  mediaAltText: string | null;
  status: string;
  approvalMode: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedCaption: string | null;
  scheduledAt: string | null;
  externalId: string | null;
  permalink: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

// social_posts table is created by db.ts STARTUP_MIGRATIONS (no lazy init needed)

function rowToRecord(row: Record<string, unknown>): SocialPostRecord {
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    connectorId: row.connector_id as string,
    platform: row.platform as string,
    targetId: row.target_id as string,
    contentType: row.content_type as string,
    caption: row.caption as string,
    mediaUrls: JSON.parse((row.media_urls as string) || '[]'),
    mediaAltText: row.media_alt_text as string | null,
    status: row.status as string,
    approvalMode: row.approval_mode as string,
    approvedBy: row.approved_by as string | null,
    approvedAt: row.approved_at as string | null,
    approvedCaption: row.approved_caption as string | null,
    scheduledAt: row.scheduled_at as string | null,
    externalId: row.external_id as string | null,
    permalink: row.permalink as string | null,
    verifiedAt: row.verified_at as string | null,
    lastError: row.last_error as string | null,
    attemptCount: row.attempt_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function validateDraftInput(input: CreateDraftInput): void {
  const { platform, targetId, contentType, caption, mediaUrls, scheduledAt } = input;

  if (!SUPPORTED_PLATFORMS.includes(platform as Platform)) {
    throw new SocialPublishingError(
      `Unsupported platform "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}.`,
    );
  }

  if (!targetId || !targetId.trim()) {
    throw new SocialPublishingError('targetId (Page ID or Instagram Account ID) is required.');
  }

  const platformTypes = SUPPORTED_CONTENT_TYPES[platform as Platform] as readonly string[];
  if (!platformTypes.includes(contentType)) {
    throw new SocialPublishingError(
      `Content type "${contentType}" is not supported for ${platform}. ` +
      `Supported: ${platformTypes.join(', ')}.`,
    );
  }

  // Instagram requires media
  if (platform === 'instagram' && (!mediaUrls || mediaUrls.length === 0)) {
    throw new SocialPublishingError('Instagram posts require at least one media URL.');
  }

  // Carousel requires at least 2 media URLs
  if (platform === 'instagram' && contentType === 'carousel' && (!mediaUrls || mediaUrls.length < 2)) {
    throw new SocialPublishingError('Instagram carousel posts require at least 2 media URLs.');
  }

  if (!caption || !caption.trim()) {
    throw new SocialPublishingError('Caption is required and cannot be empty.');
  }

  const maxLen = platform === 'instagram' ? IG_CAPTION_MAX : FB_CAPTION_MAX;
  if (caption.length > maxLen) {
    throw new SocialPublishingError(
      `Caption length (${caption.length}) exceeds the ${platform} limit of ${maxLen} characters.`,
    );
  }

  if (scheduledAt) {
    const scheduledTime = new Date(scheduledAt).getTime();
    if (isNaN(scheduledTime) || scheduledTime <= Date.now()) {
      throw new SocialPublishingError('scheduledAt must be a valid ISO 8601 datetime in the future.');
    }
  }
}

export async function createDraft(input: CreateDraftInput): Promise<SocialPostRecord> {

  validateDraftInput(input);

  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO social_posts
      (id, business_id, connector_id, platform, target_id, content_type, caption,
       media_urls, media_alt_text, status, approval_mode, scheduled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'requires_approval', ?, ?, ?)
  `).run(
    id,
    input.businessId,
    input.connectorId,
    input.platform,
    input.targetId,
    input.contentType,
    input.caption,
    JSON.stringify(input.mediaUrls || []),
    input.mediaAltText ?? null,
    input.scheduledAt ?? null,
    now,
    now,
  );

  return getPost(id, input.businessId) as Promise<SocialPostRecord>;
}

export async function getPost(postId: string, businessId: string): Promise<SocialPostRecord | null> {

  const row = db.prepare(`SELECT * FROM social_posts WHERE id = ? AND business_id = ?`)
    .get(postId, businessId) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToRecord(row);
}

export async function listPosts(
  businessId: string,
  filters: { status?: string; platform?: string; limit?: number; offset?: number },
): Promise<SocialPostRecord[]> {

  const conditions: string[] = ['business_id = ?'];
  const params: unknown[] = [businessId];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.platform) {
    conditions.push('platform = ?');
    params.push(filters.platform);
  }

  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);

  const rows = db.prepare(
    `SELECT * FROM social_posts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...(params as (string | number | boolean | null)[])) as Record<string, unknown>[];

  return rows.map(rowToRecord);
}

export async function approveDraft(
  postId: string,
  businessId: string,
  approvedBy: string,
): Promise<SocialPostRecord> {

  const post = await getPost(postId, businessId);
  if (!post) {
    throw new SocialPublishingError(`Post "${postId}" not found for business "${businessId}".`);
  }
  if (post.status !== 'draft') {
    throw new SocialPublishingError(
      `Cannot approve post in status "${post.status}". Only draft posts can be approved.`,
    );
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE social_posts
    SET status = 'approved', approved_by = ?, approved_at = ?, approved_caption = ?, updated_at = ?
    WHERE id = ? AND business_id = ?
  `).run(approvedBy, now, post.caption, now, postId, businessId);

  return getPost(postId, businessId) as Promise<SocialPostRecord>;
}

export async function cancelPost(
  postId: string,
  businessId: string,
  cancelledBy: string,
): Promise<SocialPostRecord> {

  const post = await getPost(postId, businessId);
  if (!post) {
    throw new SocialPublishingError(`Post "${postId}" not found for business "${businessId}".`);
  }
  const terminalStatuses = ['published', 'cancelled'];
  if (terminalStatuses.includes(post.status)) {
    throw new SocialPublishingError(
      `Cannot cancel post in status "${post.status}". Only draft, approved, or scheduled posts can be cancelled.`,
    );
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE social_posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND business_id = ?
  `).run(now, postId, businessId);

  return getPost(postId, businessId) as Promise<SocialPostRecord>;
}

/** Returns true if the HTTP status code indicates a transient (retryable) error. */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * In production, validates that media URLs are Blueprint-staged URLs (not arbitrary remote URLs).
 * Uses exact hostname + path prefix matching to prevent SSRF bypass via subdomain tricks.
 */
function validateMediaUrlsAreStagedBlueprint(mediaUrls: string[]): void {
  if (mediaUrls.length === 0) return;
  if (process.env.NODE_ENV !== 'production') return;

  const baseUrlEnv = process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL;
  if (!baseUrlEnv) {
    throw new SocialPublishingError('SOCIAL_MEDIA_PUBLIC_BASE_URL is not configured — cannot validate media URLs.');
  }

  let allowedBase: URL;
  try {
    allowedBase = new URL(baseUrlEnv);
  } catch {
    throw new SocialPublishingError(`SOCIAL_MEDIA_PUBLIC_BASE_URL "${baseUrlEnv}" is not a valid URL.`);
  }

  for (const url of mediaUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SocialPublishingError(`Media URL "${url}" is not a valid URL.`);
    }
    // Exact hostname and protocol comparison prevents SSRF via:
    // - 'https://trusted.example.evil.com/...' (different hostname)
    // - 'https://evil.example.com?/social-media/...' (different hostname)
    // - 'http://trusted.example.com/...' (wrong protocol in prod)
    if (
      parsed.hostname !== allowedBase.hostname ||
      parsed.protocol !== allowedBase.protocol ||
      !parsed.pathname.startsWith('/social-media/')
    ) {
      throw new SocialPublishingError(
        `Media URL "${url.substring(0, 100)}" must be a Blueprint staging URL ` +
        `(${allowedBase.origin}/social-media/...). ` +
        `Upload media through the staging endpoint first.`,
      );
    }
  }
}

/** Poll a container until FINISHED, ERROR, or EXPIRED. Returns the final status_code string. */
async function pollContainerStatus(
  containerId: string,
  client: GraphClient,
  opts: { fetchFn?: FetchFn; maxContainerPollAttempts?: number },
): Promise<string> {
  const { fetchFn, maxContainerPollAttempts = 10 } = opts;
  let statusCode = '';
  for (let i = 0; i < maxContainerPollAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await client.get(
      `/${containerId}`,
      { fields: 'status_code,status' },
      { fetchFn } as any,
    ) as { status_code?: string; status?: string };
    statusCode = statusRes.status_code ?? '';
    if (statusCode === 'FINISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new SocialPublishingError(
        `Instagram container failed with status: ${statusCode} ${statusRes.status ?? ''}`,
      );
    }
  }
  return statusCode;
}

interface PublishOptions {
  fetchFn?: FetchFn;
  maxContainerPollAttempts?: number;
  /** When true, skip the approved-status check and attempt_count increment (already done by worker). */
  alreadyClaimed?: boolean;
  /** Page access token for Facebook Page publishing (preferred over user token). */
  pageAccessToken?: string;
}

/**
 * Publish an approved post immediately to Meta.
 *
 * Security:
 * - Atomically claims the post via conditional UPDATE to prevent concurrent dual-publish
 * - Revalidates targetId against the bound account in connector config before publishing
 * - External ID persisted before readback so a failed readback retry doesn't re-create the post
 *
 * For Instagram: creates a container, polls until FINISHED, then publishes and verifies.
 * For Facebook: uses Page access token, posts to appropriate endpoint, reads back to verify permalink.
 *
 * Returns the updated SocialPostRecord.
 */
export async function publishNow(
  postId: string,
  businessId: string,
  accessToken: string,
  opts: PublishOptions,
): Promise<SocialPostRecord> {

  const { alreadyClaimed = false } = opts;

  // If already claimed by the worker (status='publishing'), load the post directly.
  // Otherwise, atomically claim: only one concurrent caller can succeed.
  let post: SocialPostRecord | null;

  if (alreadyClaimed) {
    post = await getPost(postId, businessId);
    if (!post) throw new SocialPublishingError(`Post "${postId}" not found for business "${businessId}".`);
    if (post.status === 'published') return post; // Idempotent
    if (post.status !== 'publishing') {
      throw new SocialPublishingError(
        `Worker expected post "${postId}" to be in 'publishing' status but found "${post.status}".`,
      );
    }
  } else {
    // Idempotency: check for already published before claiming
    const existing = await getPost(postId, businessId);
    if (!existing) throw new SocialPublishingError(`Post "${postId}" not found for business "${businessId}".`);
    if (existing.status === 'published') return existing;

    const now = new Date().toISOString();
    const claim = db.prepare(`
      UPDATE social_posts
      SET status = 'publishing', attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND business_id = ? AND status = 'approved'
    `).run(now, postId, businessId);

    if (claim.changes !== 1) {
      // Lost the race or wrong status
      const current = await getPost(postId, businessId);
      if (current?.status === 'published') return current;
      throw new SocialPublishingError(
        `Cannot publish post "${postId}" — current status is "${current?.status ?? 'unknown'}". ` +
        'Post must be in "approved" status. Another process may be publishing it.',
      );
    }

    post = await getPost(postId, businessId);
    if (!post) throw new SocialPublishingError(`Post "${postId}" disappeared after claim.`);
  }

  // Revalidate target binding: post.targetId must match the bound account in connector config
  const connectorRow = db.prepare(
    `SELECT config, credentials FROM connectors WHERE id = ? AND business_id = ?`,
  ).get(post.connectorId, businessId) as { config: string; credentials: string } | null;

  if (!connectorRow) {
    const errMsg = `Connector "${post.connectorId}" not found for business "${businessId}".`;
    db.prepare(`UPDATE social_posts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(errMsg, postId, businessId);
    return getPost(postId, businessId) as Promise<SocialPostRecord>;
  }

  let config: Record<string, unknown> = {};
  try { config = JSON.parse(connectorRow.config || '{}'); } catch {}

  const boundPageId = (config.facebookPageId as string) || null;
  const boundIgId = (config.instagramAccountId as string) || null;

  if (post.platform === 'facebook' && post.targetId !== boundPageId) {
    const errMsg = `Target "${post.targetId}" does not match the bound Facebook Page "${boundPageId}". ` +
      'Re-create the draft with the correct target ID or re-bind the account.';
    db.prepare(`UPDATE social_posts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(errMsg.substring(0, 500), postId, businessId);
    return getPost(postId, businessId) as Promise<SocialPostRecord>;
  }

  if (post.platform === 'instagram' && post.targetId !== boundIgId) {
    const errMsg = `Target "${post.targetId}" does not match the bound Instagram account "${boundIgId}". ` +
      'Re-create the draft with the correct target ID or re-bind the account.';
    db.prepare(`UPDATE social_posts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(errMsg.substring(0, 500), postId, businessId);
    return getPost(postId, businessId) as Promise<SocialPostRecord>;
  }

  // For Facebook Page publishing, prefer the Page access token stored in credentials
  let publishToken = accessToken;
  if (post.platform === 'facebook' && opts.pageAccessToken) {
    publishToken = opts.pageAccessToken;
  }

  const caption = post.approvedCaption ?? post.caption;
  const creds = { access_token: publishToken };
  const client = new GraphClient(creds);

  try {
    // If an external ID already exists (from a prior attempt that succeeded on Meta but failed
    // before saving "published" status), skip re-creation and go straight to readback.
    if (post.externalId) {
      const result = await retryReadback(post, client, opts);
      const verifiedAt = new Date().toISOString();
      db.prepare(`
        UPDATE social_posts
        SET status = 'published', permalink = ?, verified_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND business_id = ?
      `).run(result.permalink, verifiedAt, verifiedAt, postId, businessId);
      return getPost(postId, businessId) as Promise<SocialPostRecord>;
    }

    let externalId: string;
    let permalink: string;

    if (post.platform === 'instagram') {
      ({ externalId, permalink } = await publishInstagram(post, client, caption, opts));
    } else {
      ({ externalId, permalink } = await publishFacebook(post, client, caption, opts));
    }

    const verifiedAt = new Date().toISOString();
    db.prepare(`
      UPDATE social_posts
      SET status = 'published', external_id = ?, permalink = ?, verified_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND business_id = ?
    `).run(externalId, permalink, verifiedAt, verifiedAt, postId, businessId);

    return getPost(postId, businessId) as Promise<SocialPostRecord>;
  } catch (err) {
    const errorMsg = (err as Error).message?.substring(0, 500) ?? 'Unknown error';
    const retriable = err instanceof GraphApiError && isRetryable(err.status);
    const newStatus = retriable ? 'draft' : 'failed';
    db.prepare(`
      UPDATE social_posts SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND business_id = ?
    `).run(newStatus, errorMsg, new Date().toISOString(), postId, businessId);
    return getPost(postId, businessId) as Promise<SocialPostRecord>;
  }
}

/** Read back an existing post by its external ID (for retry after readback failure). */
async function retryReadback(
  post: SocialPostRecord,
  client: GraphClient,
  opts: PublishOptions,
): Promise<{ permalink: string }> {
  const { fetchFn } = opts;
  if (!post.externalId) throw new SocialPublishingError('No external ID to read back.');

  if (post.platform === 'instagram') {
    const readback = await client.get(`/${post.externalId}`, { fields: 'id,permalink,timestamp' }, { fetchFn } as any) as { permalink?: string };
    if (!readback.permalink) throw new SocialPublishingError('Instagram: readback did not return a permalink.');
    return { permalink: readback.permalink };
  } else {
    const readback = await client.get(`/${post.externalId}`, { fields: 'id,permalink_url,created_time' }, { fetchFn } as any) as { permalink_url?: string };
    if (!readback.permalink_url) throw new SocialPublishingError('Facebook: readback did not return a permalink_url.');
    return { permalink: readback.permalink_url };
  }
}

async function publishInstagram(
  post: SocialPostRecord,
  client: GraphClient,
  caption: string,
  opts: PublishOptions,
): Promise<{ externalId: string; permalink: string }> {
  const { fetchFn, maxContainerPollAttempts = 10 } = opts;

  validateMediaUrlsAreStagedBlueprint(post.mediaUrls);

  if (post.contentType === 'carousel') {
    return publishInstagramCarousel(post, client, caption, opts);
  }

  const mediaUrl = post.mediaUrls[0];

  // Step 1: Create media container
  const containerParams: Record<string, string | number | boolean | null> = { caption };
  if (post.contentType === 'image') {
    containerParams.image_url = mediaUrl ?? null;
    if (post.mediaAltText) containerParams.alt_text = post.mediaAltText;
  } else if (post.contentType === 'video' || post.contentType === 'reel') {
    containerParams.video_url = mediaUrl ?? null;
    if (post.contentType === 'reel') containerParams.media_type = 'REELS';
  }

  const containerRes = await client.post(`/${post.targetId}/media`, containerParams, { fetchFn } as any) as { id: string };
  const containerId = containerRes.id;
  if (!containerId) throw new SocialPublishingError('Instagram: no container ID returned.');

  // Step 2: Poll for container status
  const statusCode = await pollContainerStatus(containerId, client, { fetchFn, maxContainerPollAttempts });
  if (statusCode !== 'FINISHED') {
    throw new SocialPublishingError(`Instagram container did not reach FINISHED state (last: ${statusCode}).`);
  }

  // Step 3: Publish the container
  const publishRes = await client.post(`/${post.targetId}/media_publish`, { creation_id: containerId }, { fetchFn } as any) as { id: string };
  const mediaId = publishRes.id;
  if (!mediaId) throw new SocialPublishingError('Instagram: no media ID returned from media_publish.');

  // Persist external ID immediately so a readback-failure retry skips re-creation
  db.prepare(`UPDATE social_posts SET external_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
    .run(mediaId, post.id, post.businessId);

  // Step 4: Readback verification
  const readback = await client.get(`/${mediaId}`, { fields: 'id,permalink,timestamp' }, { fetchFn } as any) as { id: string; permalink?: string; timestamp?: string };
  if (!readback.permalink) throw new SocialPublishingError('Instagram: readback did not return a permalink — publish status uncertain.');

  return { externalId: mediaId, permalink: readback.permalink };
}

async function publishInstagramCarousel(
  post: SocialPostRecord,
  client: GraphClient,
  caption: string,
  opts: PublishOptions,
): Promise<{ externalId: string; permalink: string }> {
  const { fetchFn, maxContainerPollAttempts = 10 } = opts;

  // Step 1: Create and poll each child container
  const childIds: string[] = [];
  for (const mediaUrl of post.mediaUrls) {
    const childParams: Record<string, string | number | boolean | null> = {
      image_url: mediaUrl,
      is_carousel_item: true,
    };
    if (post.mediaAltText) childParams.alt_text = post.mediaAltText;

    const childRes = await client.post(`/${post.targetId}/media`, childParams, { fetchFn } as any) as { id: string };
    if (!childRes.id) throw new SocialPublishingError('Instagram carousel: no child container ID returned.');

    const childStatus = await pollContainerStatus(childRes.id, client, { fetchFn, maxContainerPollAttempts });
    if (childStatus !== 'FINISHED') {
      throw new SocialPublishingError(
        `Instagram carousel child container did not reach FINISHED state (last: ${childStatus}).`,
      );
    }
    childIds.push(childRes.id);
  }

  // Step 2: Create parent carousel container
  const parentRes = await client.post(`/${post.targetId}/media`, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
  }, { fetchFn } as any) as { id: string };
  const parentId = parentRes.id;
  if (!parentId) throw new SocialPublishingError('Instagram carousel: no parent container ID returned.');

  // Step 3: Poll parent until FINISHED
  const parentStatus = await pollContainerStatus(parentId, client, { fetchFn, maxContainerPollAttempts });
  if (parentStatus !== 'FINISHED') {
    throw new SocialPublishingError(
      `Instagram carousel parent container did not reach FINISHED state (last: ${parentStatus}).`,
    );
  }

  // Step 4: Publish the parent container
  const publishRes = await client.post(`/${post.targetId}/media_publish`, { creation_id: parentId }, { fetchFn } as any) as { id: string };
  const mediaId = publishRes.id;
  if (!mediaId) throw new SocialPublishingError('Instagram carousel: no media ID returned from media_publish.');

  // Persist external ID immediately so a readback-failure retry skips re-creation
  db.prepare(`UPDATE social_posts SET external_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
    .run(mediaId, post.id, post.businessId);

  // Step 5: Readback verification
  const readback = await client.get(`/${mediaId}`, { fields: 'id,permalink,timestamp' }, { fetchFn } as any) as { id: string; permalink?: string; timestamp?: string };
  if (!readback.permalink) throw new SocialPublishingError('Instagram carousel: readback did not return a permalink.');

  return { externalId: mediaId, permalink: readback.permalink };
}

async function publishFacebook(
  post: SocialPostRecord,
  client: GraphClient,
  caption: string,
  opts: PublishOptions,
): Promise<{ externalId: string; permalink: string }> {
  const { fetchFn } = opts;

  if (post.contentType === 'image') {
    validateMediaUrlsAreStagedBlueprint(post.mediaUrls);
    const mediaUrl = post.mediaUrls[0];

    const photoRes = await client.post(`/${post.targetId}/photos`, {
      url: mediaUrl ?? null,
      caption,
    }, { fetchFn } as any) as { id: string; post_id?: string };
    if (!photoRes.id) throw new SocialPublishingError('Facebook: no photo ID returned from /photos.');

    // Persist external ID before readback attempt
    db.prepare(`UPDATE social_posts SET external_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(photoRes.id, post.id, post.businessId);

    const readbackId = photoRes.post_id ?? photoRes.id;
    const readback = await client.get(`/${readbackId}`, { fields: 'id,permalink_url,created_time' }, { fetchFn } as any) as { id: string; permalink_url?: string; created_time?: string };
    if (!readback.permalink_url) throw new SocialPublishingError('Facebook: readback did not return a permalink_url for image.');

    return { externalId: photoRes.id, permalink: readback.permalink_url };
  }

  if (post.contentType === 'multi_image') {
    validateMediaUrlsAreStagedBlueprint(post.mediaUrls);

    // Step 1: Upload each image as an unpublished photo
    const photoIds: string[] = [];
    for (const mediaUrl of post.mediaUrls) {
      const photoRes = await client.post(`/${post.targetId}/photos`, {
        url: mediaUrl,
        published: false,
      }, { fetchFn } as any) as { id: string };
      if (!photoRes.id) throw new SocialPublishingError('Facebook: no photo ID returned from /photos for multi_image.');
      photoIds.push(photoRes.id);
    }

    // Step 2: Create feed post with attached_media
    const attachedMedia = JSON.stringify(photoIds.map(id => ({ media_fbid: id })));
    const feedRes = await client.post(`/${post.targetId}/feed`, {
      message: caption,
      attached_media: attachedMedia,
    }, { fetchFn } as any) as { id: string };
    if (!feedRes.id) throw new SocialPublishingError('Facebook: no post ID returned from /feed for multi_image.');

    // Persist external ID before readback
    db.prepare(`UPDATE social_posts SET external_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(feedRes.id, post.id, post.businessId);

    const readback = await client.get(`/${feedRes.id}`, { fields: 'id,permalink_url,created_time' }, { fetchFn } as any) as { id: string; permalink_url?: string; created_time?: string };
    if (!readback.permalink_url) throw new SocialPublishingError('Facebook: readback did not return a permalink_url for multi_image.');

    return { externalId: feedRes.id, permalink: readback.permalink_url };
  }

  // Default: text-only post to feed
  const feedRes = await client.post(`/${post.targetId}/feed`, { message: caption }, { fetchFn } as any) as { id: string };
  const postId = feedRes.id;
  if (!postId) throw new SocialPublishingError('Facebook: no post ID returned from /feed.');

  // Persist external ID before readback
  db.prepare(`UPDATE social_posts SET external_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
    .run(postId, post.id, post.businessId);

  const readback = await client.get(`/${postId}`, { fields: 'id,permalink_url,created_time' }, { fetchFn } as any) as { id: string; permalink_url?: string; created_time?: string };
  if (!readback.permalink_url) throw new SocialPublishingError('Facebook: readback did not return a permalink_url — publish status uncertain.');

  return { externalId: postId, permalink: readback.permalink_url };
}
