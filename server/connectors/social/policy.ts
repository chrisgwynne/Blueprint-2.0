/**
 * Per-business, per-connector social publishing policy.
 *
 * Modes:
 *   drafts_only         — posts can be created as drafts only; no publishing (manual export required)
 *   approval_required   — posts must be approved by a human before publishing (default)
 *   immediate           — posts can be published immediately after creation (use only for trusted workflows)
 */
import db from '../../db/db.js';

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export interface SocialPolicy {
  mode: 'drafts_only' | 'approval_required' | 'immediate';
  allowedPlatforms: string[];
  allowedContentTypes: string[];
  maxDailyPosts: number;
  maxWeeklyPosts: number;
}

const DEFAULT_POLICY: SocialPolicy = {
  mode: 'approval_required',
  allowedPlatforms: ['facebook', 'instagram'],
  allowedContentTypes: ['text', 'image', 'carousel', 'video', 'reel', 'multi_image'],
  maxDailyPosts: 10,
  maxWeeklyPosts: 30,
};

const POLICY_SETTINGS_PREFIX = 'social_policy:';

function policyKey(connectorId: string): string {
  return `${POLICY_SETTINGS_PREFIX}${connectorId}`;
}

export async function getPolicy(businessId: string, connectorId: string): Promise<SocialPolicy> {
  const key = policyKey(connectorId);
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
  if (!row) return { ...DEFAULT_POLICY };

  try {
    const stored = JSON.parse(row.value) as Partial<SocialPolicy>;
    return { ...DEFAULT_POLICY, ...stored };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function setPolicy(
  businessId: string,
  connectorId: string,
  policy: Partial<SocialPolicy>,
): Promise<SocialPolicy> {
  const existing = await getPolicy(businessId, connectorId);
  const merged: SocialPolicy = { ...existing, ...policy };

  // Clamp numeric limits to sane bounds
  merged.maxDailyPosts = Math.min(Math.max(1, merged.maxDailyPosts), 100);
  merged.maxWeeklyPosts = Math.min(Math.max(1, merged.maxWeeklyPosts), 500);

  const key = policyKey(connectorId);
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, JSON.stringify(merged));
  return merged;
}

interface PostCheckContext {
  platform: string;
  publishNow?: boolean;
  hasApproval?: boolean;
  contentType?: string;
}

export async function checkPostAllowed(
  businessId: string,
  connectorId: string,
  context: PostCheckContext,
): Promise<void> {
  const policy = await getPolicy(businessId, connectorId);
  const { platform, publishNow: isPublishNow, hasApproval, contentType } = context;

  // Platform check
  if (policy.allowedPlatforms.length > 0 && !policy.allowedPlatforms.includes(platform)) {
    throw new PolicyViolationError(
      `Platform "${platform}" is not allowed for this connector. ` +
      `Allowed: ${policy.allowedPlatforms.join(', ')}.`,
    );
  }

  // Content type check
  if (contentType && policy.allowedContentTypes.length > 0 && !policy.allowedContentTypes.includes(contentType)) {
    throw new PolicyViolationError(
      `Content type "${contentType}" is not allowed for this connector. ` +
      `Allowed: ${policy.allowedContentTypes.join(', ')}.`,
    );
  }

  // Publishing mode and approval check
  if (isPublishNow) {
    if (policy.mode === 'drafts_only') {
      throw new PolicyViolationError(
        'This connector is in drafts_only mode — posts cannot be published directly. Create a draft and export manually.',
      );
    }
    if (policy.mode === 'approval_required' && !hasApproval) {
      throw new PolicyViolationError(
        'This connector requires approval before publishing. Approve the post first.',
      );
    }

    // Enforce daily post limit at publish time
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const dailyCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM social_posts
      WHERE business_id = ? AND connector_id = ? AND platform = ?
        AND status = 'published'
        AND datetime(verified_at) >= datetime(?)
    `).get(businessId, connectorId, platform, todayUtc.toISOString()) as { cnt: number }).cnt;

    if (dailyCount >= policy.maxDailyPosts) {
      throw new PolicyViolationError(
        `Daily post limit of ${policy.maxDailyPosts} reached for ${platform}. ` +
        `Try again tomorrow or increase the limit in policy settings.`,
      );
    }

    // Enforce weekly post limit
    const weekUtc = new Date();
    weekUtc.setUTCDate(weekUtc.getUTCDate() - weekUtc.getUTCDay()); // Sunday
    weekUtc.setUTCHours(0, 0, 0, 0);
    const weeklyCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM social_posts
      WHERE business_id = ? AND connector_id = ? AND platform = ?
        AND status = 'published'
        AND datetime(verified_at) >= datetime(?)
    `).get(businessId, connectorId, platform, weekUtc.toISOString()) as { cnt: number }).cnt;

    if (weeklyCount >= policy.maxWeeklyPosts) {
      throw new PolicyViolationError(
        `Weekly post limit of ${policy.maxWeeklyPosts} reached for ${platform}. ` +
        `Try again next week or increase the limit in policy settings.`,
      );
    }
  }
}
