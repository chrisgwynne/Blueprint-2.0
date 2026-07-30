/**
 * REST API routes for Meta social publishing.
 *
 * All routes require authentication (isAuthenticated middleware).
 * All routes enforce tenant isolation — business_id comes from the URL and
 * is matched against the connector's business_id before any operation.
 * Business existence is verified to prevent crafted business IDs.
 *
 * GET  /api/social-publishing/:businessId/preflight          — config health check
 * GET  /api/social-publishing/:businessId/capabilities       — supported platform/content capabilities
 * GET  /api/social-publishing/:businessId/accounts           — stored account identifiers
 * GET  /api/social-publishing/:businessId/accounts/discover  — live discovery via Graph API
 * POST /api/social-publishing/:businessId/accounts/bind      — bind Facebook Page + Instagram identity
 * GET  /api/social-publishing/:businessId/policy             — get publishing policy
 * PUT  /api/social-publishing/:businessId/policy             — update publishing policy
 * GET  /api/social-publishing/:businessId/posts              — list posts
 * GET  /api/social-publishing/:businessId/posts/:id          — get post
 * POST /api/social-publishing/:businessId/posts              — create draft
 * POST /api/social-publishing/:businessId/posts/:id/approve  — approve draft
 * POST /api/social-publishing/:businessId/posts/:id/cancel   — cancel post
 * POST /api/social-publishing/:businessId/posts/:id/publish  — publish immediately
 * POST /api/social-publishing/:businessId/media/upload       — stage media file
 * DELETE /api/social-publishing/:businessId/media/:token     — remove staged media
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import db from '../db/db.js';
import { decrypt, encrypt } from '../crypto.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  createDraft,
  getPost,
  listPosts,
  approveDraft,
  cancelPost,
  publishNow,
  SocialPublishingError,
} from '../connectors/social/publishing.js';
import { checkPostAllowed, getPolicy, setPolicy, PolicyViolationError } from '../connectors/social/policy.js';
import { GraphClient, GraphApiError } from '../connectors/social/graph-client.js';
import {
  stageMediaFile,
  generateServingUrl,
  cleanupStagedFile,
  StagingError,
} from '../connectors/social/media-staging.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDecryptedCreds(connectorId: string, businessId: string): Record<string, string> | null {
  const row = db.prepare(`
    SELECT credentials FROM connectors WHERE id = ? AND business_id = ? AND type = 'social'
  `).get(connectorId, businessId) as { credentials: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.credentials));
  } catch {
    return null;
  }
}

function verifyConnectorOwnership(connectorId: string, businessId: string): boolean {
  const row = db.prepare(`
    SELECT id FROM connectors WHERE id = ? AND business_id = ? AND type = 'social'
  `).get(connectorId, businessId) as { id: string } | null;
  return !!row;
}

/** Verify the businessId corresponds to a real business (prevents crafted IDs from leaking connector data). */
function verifyBusinessExists(businessId: string): boolean {
  const row = db.prepare(`SELECT id FROM businesses WHERE id = ?`).get(businessId) as { id: string } | null;
  return !!row;
}

function getCurrentUserId(req: Request): string {
  return (req.session as any).userId || 'unknown';
}

function writeAuditLog(businessId: string, connectorId: string, event: string, details: Record<string, unknown>): void {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (?, ?, 'social_post', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(),
      businessId,
      (details.postId as string) || connectorId,
      `social.${event}`,
      (details.requestedBy as string) || (details.approvedBy as string) || (details.cancelledBy as string) || (details.createdBy as string) || (details.boundBy as string) || 'system',
      JSON.stringify({ connectorId, ...details }),
    );
  } catch {
    // audit is best-effort
  }
}

// ─── Preflight ────────────────────────────────────────────────────────────────

/**
 * GET /api/social-publishing/:businessId/preflight
 * Returns configuration health for Meta social publishing as a structured checks array.
 */
router.get('/:businessId/preflight', isAuthenticated, (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  const redirectUri = process.env.SOCIAL_REDIRECT_URI || process.env.META_REDIRECT_URI;
  const isProduction = process.env.NODE_ENV === 'production';
  const redirectOk = !!redirectUri && (!isProduction || redirectUri.startsWith('https://'));

  const checks = [
    {
      key: 'meta_app_id',
      label: 'Meta App ID',
      ok: !!process.env.META_APP_ID,
      message: process.env.META_APP_ID ? undefined : 'Set META_APP_ID in your environment.',
    },
    {
      key: 'meta_app_secret',
      label: 'Meta App Secret',
      ok: !!process.env.META_APP_SECRET,
      message: process.env.META_APP_SECRET ? undefined : 'Set META_APP_SECRET in your environment.',
    },
    {
      key: 'redirect_uri',
      label: 'OAuth Redirect URI',
      ok: redirectOk,
      message: !redirectUri
        ? 'Set SOCIAL_REDIRECT_URI to your HTTPS callback URL.'
        : !redirectOk
        ? `SOCIAL_REDIRECT_URI must use HTTPS in production (got: ${redirectUri}).`
        : undefined,
    },
    {
      key: 'media_staging_secret',
      label: 'Media Staging Secret',
      ok: !!process.env.SOCIAL_MEDIA_STAGING_SECRET,
      message: process.env.SOCIAL_MEDIA_STAGING_SECRET ? undefined : 'Set SOCIAL_MEDIA_STAGING_SECRET (min 16 chars).',
    },
    {
      key: 'media_public_url',
      label: 'Media Public Base URL',
      ok: !!process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL,
      message: process.env.SOCIAL_MEDIA_PUBLIC_BASE_URL
        ? undefined
        : 'Set SOCIAL_MEDIA_PUBLIC_BASE_URL to the publicly reachable HTTPS base URL for media serving.',
    },
    {
      key: 'graph_version',
      label: 'Graph API Version',
      ok: true,
      message: `Using Graph API ${process.env.META_GRAPH_VERSION || 'v25.0 (default)'}`,
    },
  ];

  const issues = checks.filter((c) => !c.ok).map((c) => c.message).filter(Boolean) as string[];

  return res.json({
    configured: issues.length === 0,
    issues,
    checks,
    graphVersion: process.env.META_GRAPH_VERSION || 'v25.0 (default)',
    redirectUri: redirectUri || null,
    hasAppId: !!process.env.META_APP_ID,
    hasMediaStagingSecret: !!process.env.SOCIAL_MEDIA_STAGING_SECRET,
  });
});

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * GET /api/social-publishing/:businessId/capabilities
 * Returns truthful declaration of what content types this connector supports,
 * in both a flat array (for UI rendering) and a nested structure (for programmatic use).
 */
router.get('/:businessId/capabilities', isAuthenticated, (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  const nested = {
    facebook: {
      supported: true,
      contentTypes: {
        text: { supported: true, description: 'Text-only post to Page feed.' },
        image: { supported: true, description: 'Single photo post to Page feed.' },
        multi_image: { supported: true, description: 'Multiple photos posted as a batch to Page feed.' },
        video: { supported: false, reason: 'Facebook Page video upload requires a separate resumable upload API not yet implemented.' },
        reel: { supported: false, reason: 'Facebook Reels require Reels Publishing API — not yet implemented.' },
        story: { supported: false, reason: 'Facebook Stories require Stories Publishing API — not yet implemented.' },
      },
    },
    instagram: {
      supported: true,
      contentTypes: {
        image: { supported: true, description: 'Single image post with optional alt_text.' },
        carousel: { supported: true, description: 'Multi-image carousel (2–10 items). Child containers created first, then the parent.' },
        video: { supported: true, description: 'Video post. Container polls until FINISHED before media_publish.' },
        reel: { supported: true, description: 'Instagram Reel (media_type=REELS container).' },
        story: { supported: false, reason: 'Instagram Stories via API require Stories Publishing API — not yet implemented.' },
      },
    },
    notes: [
      'Media must be staged via Blueprint before submission — direct remote URLs are rejected to prevent SSRF.',
      'Scheduled posts require SOCIAL_MEDIA_PUBLIC_BASE_URL to be a publicly reachable HTTPS URL so Meta can fetch media.',
      'Live publishing requires Meta app to be in Live Mode with all required permissions approved via App Review.',
      'Facebook Page publishing uses a Page access token (bound at account-bind time).',
    ],
  };

  // Flatten to a Capability[] array for UI rendering
  const capabilities: Array<{ platform: string; contentType: string; supported: boolean; notes?: string }> = [];
  for (const [platform, info] of Object.entries(nested) as [string, any][]) {
    if (!info.contentTypes) continue;
    for (const [ct, ctInfo] of Object.entries(info.contentTypes) as [string, any][]) {
      capabilities.push({
        platform,
        contentType: ct,
        supported: ctInfo.supported,
        notes: ctInfo.description || ctInfo.reason,
      });
    }
  }

  return res.json({ ...nested, capabilities });
});

// ─── Account discovery ───────────────────────────────────────────────────────

/**
 * GET /api/social-publishing/:businessId/accounts
 * Returns the currently bound social account identifiers. No live Meta calls.
 */
router.get('/:businessId/accounts', isAuthenticated, (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const connectorId = req.query.connectorId as string | undefined;

  let query = `SELECT id, config FROM connectors WHERE business_id = ? AND type = 'social' AND status = 'connected'`;
  const params: unknown[] = [businessId];
  if (connectorId) {
    query += ' AND id = ?';
    params.push(connectorId);
  }
  query += ' LIMIT 1';

  const row = db.prepare(query).get(...(params as (string | number | boolean | null)[])) as { id: string; config: string } | null;

  if (!row) {
    return res.json({ facebookPageId: null, instagramAccountId: null, connectorId: null });
  }

  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.config); } catch {}

  return res.json({
    connectorId: row.id,
    facebookPageId: (config.facebookPageId as string) || null,
    facebookPageName: (config.facebookPageName as string) || null,
    instagramAccountId: (config.instagramAccountId as string) || null,
    instagramUsername: (config.instagramUsername as string) || null,
    instagramAccountType: (config.instagramAccountType as string) || null,
    boundAt: (config.boundAt as string) || null,
  });
});

/**
 * GET /api/social-publishing/:businessId/accounts/discover
 * Performs a live Graph API call to list managed Facebook Pages and their
 * linked Instagram Business/Creator accounts.
 */
router.get('/:businessId/accounts/discover', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const connectorId = req.query.connectorId as string | undefined;

  let query = `SELECT id, credentials FROM connectors WHERE business_id = ? AND type = 'social' AND status = 'connected'`;
  const params: unknown[] = [businessId];
  if (connectorId) {
    query += ' AND id = ?';
    params.push(connectorId);
  }
  query += ' LIMIT 1';
  const row = db.prepare(query).get(...(params as (string | number | boolean | null)[])) as { id: string; credentials: string } | null;
  if (!row) {
    return res.status(404).json({ error: 'No connected social connector found for this business.' });
  }

  let creds: Record<string, string>;
  try {
    creds = JSON.parse(decrypt(row.credentials));
  } catch {
    return res.status(400).json({ error: 'Cannot decrypt connector credentials. Please reconnect.' });
  }

  const accessToken = creds.accessToken || creds.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'Connector is missing access token. Please reconnect.' });
  }

  const expiresAt = Number(creds.expiresAt || creds.token_expires_at || 0);
  const tokenExpired = expiresAt > 0 && expiresAt < Date.now();
  if (tokenExpired) {
    return res.status(400).json({
      error: 'Access token has expired. Please reconnect via Settings → Connectors → Social.',
      code: 'TOKEN_EXPIRED',
    });
  }

  try {
    const client = new GraphClient({ access_token: accessToken });
    const pages = await client.listManagedPages();

    const results = await Promise.all(
      pages.map(async (page) => {
        let instagram: { id: string; username: string; account_type: string; followers_count?: number } | null = null;
        try {
          instagram = await client.getInstagramAccountForPage(page.id);
        } catch {
          // not all pages have IG
        }
        return {
          facebookPageId: page.id,
          facebookPageName: page.name,
          facebookPageCategory: page.category || null,
          instagram: instagram
            ? {
                id: instagram.id,
                username: instagram.username,
                accountType: instagram.account_type,
                followersCount: instagram.followers_count ?? null,
              }
            : null,
        };
      }),
    );

    return res.json({
      connectorId: row.id,
      accounts: results,
      tokenExpiresAt: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
    });
  } catch (err) {
    if (err instanceof GraphApiError) {
      const status = err.status === 401 || err.status === 403 ? 400 : 500;
      return res.status(status).json({
        error: err.message,
        code: err.status === 401 || err.status === 403 ? 'TOKEN_INVALID' : 'GRAPH_ERROR',
      });
    }
    throw err;
  }
});

/**
 * POST /api/social-publishing/:businessId/accounts/bind
 * Explicitly bind a selected Facebook Page (and optionally its linked Instagram
 * Business/Creator account) into the connector config.
 *
 * Also stores the Page access token in credentials so it can be used for Page publishing.
 *
 * Body: { connectorId, facebookPageId }
 */
router.post('/:businessId/accounts/bind', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const { connectorId, facebookPageId } = req.body as { connectorId?: string; facebookPageId?: string };

  if (!connectorId) return res.status(400).json({ error: 'connectorId is required.' });
  if (!facebookPageId) return res.status(400).json({ error: 'facebookPageId is required.' });

  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  const creds = getDecryptedCreds(connectorId, businessId);
  const accessToken = creds?.accessToken || creds?.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'Connector is missing access token. Please reconnect.' });
  }

  try {
    const client = new GraphClient({ access_token: accessToken });

    // Verify the page is actually managed by this token
    const pages = await client.listManagedPages();
    const page = pages.find((p) => p.id === facebookPageId);
    if (!page) {
      return res.status(400).json({
        error: `Facebook Page "${facebookPageId}" is not managed by this connector's token. ` +
          'Ensure the account has the Page Role and try reconnecting.',
      });
    }

    // Discover linked Instagram account (if any)
    let igAccount: { id: string; username: string; account_type: string } | null = null;
    try {
      igAccount = await client.getInstagramAccountForPage(facebookPageId);
    } catch {
      // no IG linked — not an error
    }

    // Store the Page access token in credentials so it can be used for Page publishing.
    // Page tokens are preferred over user tokens for Page posts.
    if (creds && page.access_token) {
      const updatedCreds = {
        ...creds,
        pageAccessToken: page.access_token,
        facebookPageId: page.id,
      };
      const credRow = db.prepare(`SELECT credentials FROM connectors WHERE id = ? AND business_id = ?`)
        .get(connectorId, businessId) as { credentials: string } | null;
      if (credRow) {
        db.prepare(`UPDATE connectors SET credentials = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
          .run(encrypt(JSON.stringify(updatedCreds)), connectorId, businessId);
      }
    }

    // Persist binding into connector config
    const existingRow = db.prepare(`SELECT config FROM connectors WHERE id = ? AND business_id = ?`)
      .get(connectorId, businessId) as { config: string } | null;
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(existingRow?.config || '{}'); } catch {}

    config.facebookPageId = page.id;
    config.facebookPageName = page.name;
    config.instagramAccountId = igAccount?.id || null;
    config.instagramUsername = igAccount?.username || null;
    config.instagramAccountType = igAccount?.account_type || null;
    config.boundAt = new Date().toISOString();
    config.boundBy = getCurrentUserId(req);
    config.hasPageToken = !!(page.access_token); // Boolean flag only — token itself is in credentials

    db.prepare(`UPDATE connectors SET config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?`)
      .run(JSON.stringify(config), connectorId, businessId);

    writeAuditLog(businessId, connectorId, 'account_bound', {
      facebookPageId: page.id,
      facebookPageName: page.name,
      instagramAccountId: igAccount?.id || null,
      instagramUsername: igAccount?.username || null,
      hasPageToken: !!(page.access_token),
      boundBy: getCurrentUserId(req),
    });

    return res.json({
      connectorId,
      facebookPageId: page.id,
      facebookPageName: page.name,
      instagramAccountId: igAccount?.id || null,
      instagramUsername: igAccount?.username || null,
      instagramAccountType: igAccount?.account_type || null,
      boundAt: config.boundAt,
    });
  } catch (err) {
    if (err instanceof GraphApiError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// ─── Policy CRUD ─────────────────────────────────────────────────────────────

/**
 * GET /api/social-publishing/:businessId/policy
 * Returns the publishing policy for the business's social connector.
 * Response shape: { connectorId, mode, allowedPlatforms, allowedContentTypes, maxDailyPosts, maxWeeklyPosts }
 */
router.get('/:businessId/policy', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const connectorId = req.query.connectorId as string | undefined;

  if (!connectorId) return res.status(400).json({ error: 'connectorId query parameter is required.' });
  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  const policy = await getPolicy(businessId, connectorId);
  return res.json({ policy });
});

/**
 * PUT /api/social-publishing/:businessId/policy
 * Update the publishing policy.
 * Body: { connectorId, mode?, maxDailyPosts?, maxWeeklyPosts?, ... }
 */
router.put('/:businessId/policy', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const { connectorId, ...policyUpdate } = req.body as { connectorId?: string; [k: string]: unknown };

  if (!connectorId) return res.status(400).json({ error: 'connectorId is required in the request body.' });
  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  const validModes = ['drafts_only', 'approval_required', 'immediate'];
  if (policyUpdate.mode !== undefined && !validModes.includes(policyUpdate.mode as string)) {
    return res.status(400).json({ error: `Invalid mode "${policyUpdate.mode}". Valid modes: ${validModes.join(', ')}.` });
  }

  try {
    const policy = await setPolicy(businessId, connectorId, policyUpdate as any);
    writeAuditLog(businessId, connectorId, 'policy_updated', { updatedBy: getCurrentUserId(req), ...policy });
    return res.json({ policy });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Posts CRUD ──────────────────────────────────────────────────────────────

router.get('/:businessId/posts', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const { status, platform, limit, offset } = req.query;

  try {
    const posts = await listPosts(businessId, {
      status: status as string | undefined,
      platform: platform as string | undefined,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });
    return res.json({ posts });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:businessId/posts/:id', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId, id } = req.params as { businessId: string; id: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const post = await getPost(id, businessId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  return res.json({ post });
});

/**
 * POST /api/social-publishing/:businessId/posts
 * Create a draft post. When policy mode is 'immediate', the draft is auto-approved.
 */
router.post('/:businessId/posts', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const { connectorId, platform, targetId, contentType, caption, mediaUrls, mediaAltText, scheduledAt } = req.body;
  const userId = getCurrentUserId(req);

  if (!connectorId) return res.status(400).json({ error: 'connectorId is required.' });

  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  // Policy check (create draft — not publishing yet)
  try {
    await checkPostAllowed(businessId, connectorId, { platform, publishNow: false, contentType });
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      return res.status(403).json({ error: err.message });
    }
    throw err;
  }

  try {
    let post = await createDraft({
      businessId,
      connectorId,
      platform,
      targetId,
      contentType,
      caption,
      mediaUrls: mediaUrls || [],
      mediaAltText,
      scheduledAt,
    });

    writeAuditLog(businessId, connectorId, 'draft_created', {
      postId: post.id,
      platform: post.platform,
      contentType: post.contentType,
      createdBy: userId,
    });

    // When policy mode is 'immediate', auto-approve so the post can be published without
    // a separate approval step.
    const policy = await getPolicy(businessId, connectorId);
    if (policy.mode === 'immediate') {
      post = await approveDraft(post.id, businessId, userId);
      writeAuditLog(businessId, connectorId, 'post_auto_approved', {
        postId: post.id,
        reason: 'policy.mode=immediate',
        approvedBy: userId,
      });
    }

    return res.status(201).json({ post });
  } catch (err) {
    if (err instanceof SocialPublishingError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

router.post('/:businessId/posts/:id/approve', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId, id } = req.params as { businessId: string; id: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const userId = getCurrentUserId(req);

  try {
    const post = await approveDraft(id, businessId, userId);
    writeAuditLog(businessId, post.connectorId, 'post_approved', { postId: id, approvedBy: userId });
    return res.json({ post });
  } catch (err) {
    if (err instanceof SocialPublishingError) {
      const msg = err.message;
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
});

router.post('/:businessId/posts/:id/cancel', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId, id } = req.params as { businessId: string; id: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const userId = getCurrentUserId(req);

  try {
    const post = await cancelPost(id, businessId, userId);
    writeAuditLog(businessId, post.connectorId, 'post_cancelled', { postId: id, cancelledBy: userId });
    return res.json({ post });
  } catch (err) {
    if (err instanceof SocialPublishingError) {
      const msg = err.message;
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
    throw err;
  }
});

/**
 * POST /api/social-publishing/:businessId/posts/:id/publish
 * Publish an approved post immediately.
 */
router.post('/:businessId/posts/:id/publish', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId, id } = req.params as { businessId: string; id: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const userId = getCurrentUserId(req);

  const post = await getPost(id, businessId);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  if (!verifyConnectorOwnership(post.connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector access denied.' });
  }

  // Policy check
  try {
    await checkPostAllowed(businessId, post.connectorId, {
      platform: post.platform,
      contentType: post.contentType,
      publishNow: true,
      hasApproval: post.status === 'approved',
    });
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      writeAuditLog(businessId, post.connectorId, 'publish_blocked', {
        postId: id,
        reason: err.message,
        requestedBy: userId,
      });
      return res.status(403).json({ error: err.message });
    }
    throw err;
  }

  const creds = getDecryptedCreds(post.connectorId, businessId);
  const accessToken = creds?.accessToken || creds?.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'Social connector is missing access credentials. Please reconnect.' });
  }

  const expiresAt = Number(creds?.expiresAt || creds?.token_expires_at || 0);
  if (expiresAt > 0 && expiresAt < Date.now()) {
    writeAuditLog(businessId, post.connectorId, 'publish_blocked', {
      postId: id,
      reason: 'Token expired',
      requestedBy: userId,
    });
    return res.status(400).json({
      error: 'Access token has expired. Please reconnect via Settings → Connectors → Social.',
      code: 'TOKEN_EXPIRED',
    });
  }

  // Use the stored Page access token for Facebook publishing if available
  const pageAccessToken = (post.platform === 'facebook' && creds?.pageAccessToken)
    ? creds.pageAccessToken
    : undefined;

  writeAuditLog(businessId, post.connectorId, 'publish_attempted', { postId: id, requestedBy: userId });

  try {
    const updated = await publishNow(id, businessId, accessToken, { pageAccessToken });
    if (updated.status === 'published') {
      writeAuditLog(businessId, post.connectorId, 'publish_succeeded', {
        postId: id,
        externalId: updated.externalId,
        permalink: updated.permalink,
        verifiedAt: updated.verifiedAt,
      });
    } else {
      writeAuditLog(businessId, post.connectorId, 'publish_failed', {
        postId: id,
        status: updated.status,
        lastError: updated.lastError,
      });
    }
    return res.json({ post: updated });
  } catch (err) {
    if (err instanceof SocialPublishingError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// ─── Media Staging ───────────────────────────────────────────────────────────

/**
 * POST /api/social-publishing/:businessId/media/upload
 * Stage a media file for use with Meta publishing.
 *
 * Body (JSON): { connectorId, filename, mimeType, data: base64string }
 *
 * Returns:
 *   stagingToken  — opaque token for cleanup/delete
 *   servingUrl    — HMAC-signed URL for Meta to fetch
 *   token         — alias for stagingToken (UI backward compat)
 *   url           — alias for servingUrl (UI backward compat)
 *   checksum, mimeType, size, expiresAt
 *
 * Note: The server body size limit of 10 MB constrains the actual upload size;
 * increase express.json({ limit }) or switch to multipart streaming for large files.
 */
router.post('/:businessId/media/upload', isAuthenticated, async (req: Request, res: Response) => {
  const { businessId } = req.params as { businessId: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const { connectorId, filename, mimeType, data } = req.body as {
    connectorId?: string;
    filename?: string;
    mimeType?: string;
    data?: string;
  };

  if (!connectorId) return res.status(400).json({ error: 'connectorId is required.' });
  if (!filename) return res.status(400).json({ error: 'filename is required.' });
  if (!mimeType) return res.status(400).json({ error: 'mimeType is required.' });
  if (!data) return res.status(400).json({ error: 'data (base64-encoded file content) is required.' });

  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'data decodes to an empty buffer.' });
    }
  } catch {
    return res.status(400).json({ error: 'data is not valid base64.' });
  }

  try {
    const result = await stageMediaFile({
      buffer,
      originalFilename: filename,
      mimeType,
      businessId,
      connectorId,
    });
    const servingUrl = generateServingUrl(result.stagingToken);
    return res.status(201).json({
      stagingToken: result.stagingToken,
      servingUrl,
      // Aliases for UI compatibility
      token: result.stagingToken,
      url: servingUrl,
      checksum: result.checksum,
      mimeType: result.mimeType,
      size: result.size,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    if (err instanceof StagingError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

/**
 * DELETE /api/social-publishing/:businessId/media/:token
 * Remove a staged media file.
 * Verifies business+connector ownership stored in the staging metadata — not just connector ownership.
 */
router.delete('/:businessId/media/:token', isAuthenticated, (req: Request, res: Response) => {
  const { businessId, token } = req.params as { businessId: string; token: string };
  if (!verifyBusinessExists(businessId)) return res.status(404).json({ error: 'Business not found.' });
  const connectorId = req.query.connectorId as string | undefined;

  if (!connectorId) return res.status(400).json({ error: 'connectorId query parameter is required.' });

  if (!verifyConnectorOwnership(connectorId, businessId)) {
    return res.status(403).json({ error: 'Connector not found or does not belong to this business.' });
  }

  // cleanupStagedFile verifies businessId+connectorId match the stored metadata
  const removed = cleanupStagedFile(token, businessId, connectorId);
  return res.json({ removed });
});

export default router;
