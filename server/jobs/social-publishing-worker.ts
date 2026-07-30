/**
 * Restart-safe scheduled social publishing worker.
 *
 * Finds approved social posts whose scheduledAt is now due (or overdue),
 * claims them atomically, and publishes them via the Meta Graph API.
 *
 * Safety properties:
 * - Only one process publishes a given post (atomic status transition claim)
 * - Idempotent: already-published posts are skipped
 * - Bounded retry: MAX_ATTEMPTS transient failures → permanent failure
 * - Permanent failures (4xx) are marked failed immediately
 * - Transient failures (429 / 5xx) reset to approved for the next tick
 * - Timezone-correct: scheduledAt is stored as UTC; due selection compares UTC
 * - Token expiry is validated before attempting publish
 * - attempt_count is incremented exactly once per attempt (by claimPost — publishNow skips it via alreadyClaimed)
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { decrypt } from '../crypto.js';
import { publishNow } from '../connectors/social/publishing.js';
import { getPolicy } from '../connectors/social/policy.js';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

interface DuePost {
  id: string;
  business_id: string;
  connector_id: string;
  platform: string;
  content_type: string;
  status: string;
  scheduled_at: string;
  attempt_count: number;
}

function findDuePosts(): DuePost[] {
  return db.prepare(`
    SELECT id, business_id, connector_id, platform, content_type, status, scheduled_at, attempt_count
    FROM social_posts
    WHERE status = 'approved'
      AND scheduled_at IS NOT NULL
      AND datetime(scheduled_at) <= datetime('now')
      AND attempt_count < ?
    ORDER BY datetime(scheduled_at) ASC
    LIMIT ?
  `).all(MAX_ATTEMPTS, BATCH_SIZE) as DuePost[];
}

/**
 * Atomically claim a post for publishing.
 * Increments attempt_count exactly once. publishNow will be called with alreadyClaimed=true
 * so it does NOT increment again.
 */
function claimPost(postId: string, businessId: string): boolean {
  const result = db.prepare(`
    UPDATE social_posts
    SET status = 'publishing', attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND business_id = ? AND status = 'approved'
  `).run(postId, businessId);
  return result.changes === 1;
}

function revertToApproved(postId: string, businessId: string, errorMsg: string): void {
  db.prepare(`
    UPDATE social_posts
    SET status = 'approved', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND business_id = ?
  `).run(errorMsg.substring(0, 500), postId, businessId);
}

function markPermanentFailure(postId: string, businessId: string, reason: string): void {
  db.prepare(`
    UPDATE social_posts
    SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND business_id = ?
  `).run(reason.substring(0, 500), postId, businessId);
}

interface ConnectorCreds {
  accessToken?: string;
  access_token?: string;
  expiresAt?: string;
  token_expires_at?: string;
  pageAccessToken?: string;
}

function getConnectorCreds(connectorId: string, businessId: string): ConnectorCreds | null {
  const row = db.prepare(`
    SELECT credentials FROM connectors WHERE id = ? AND business_id = ? AND type = 'social'
  `).get(connectorId, businessId) as { credentials: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.credentials)) as ConnectorCreds;
  } catch {
    return null;
  }
}

function getAccessToken(connectorId: string, businessId: string): string | null {
  const creds = getConnectorCreds(connectorId, businessId);
  if (!creds) return null;
  const token = creds.accessToken || creds.access_token;
  if (!token) return null;
  const expiresAt = Number(creds.expiresAt || creds.token_expires_at || 0);
  if (expiresAt > 0 && expiresAt < Date.now()) return null;
  return token;
}

function getPageAccessToken(connectorId: string, businessId: string): string | undefined {
  const creds = getConnectorCreds(connectorId, businessId);
  return creds?.pageAccessToken;
}

function writeAudit(businessId: string, postId: string, connectorId: string, event: string, meta: Record<string, unknown>): void {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, business_id, entity_type, entity_id, action, actor, metadata, created_at)
      VALUES (?, ?, 'social_post', ?, ?, 'scheduler', ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(),
      businessId,
      postId,
      `social.scheduled.${event}`,
      JSON.stringify({ connectorId, ...meta }),
    );
  } catch { /* best-effort */ }
}

/**
 * One tick of the scheduled publishing worker.
 * Returns the number of posts processed this tick.
 */
export async function runSocialPublishingWorkerTick(): Promise<number> {
  const due = findDuePosts();
  if (due.length === 0) return 0;

  let processed = 0;

  for (const post of due) {
    // Atomic claim — skip if another worker already claimed it
    if (!claimPost(post.id, post.business_id)) continue;

    const accessToken = getAccessToken(post.connector_id, post.business_id);
    if (!accessToken) {
      markPermanentFailure(post.id, post.business_id, 'No valid access token — please reconnect the social connector.');
      writeAudit(post.business_id, post.id, post.connector_id, 'failed', { reason: 'No valid access token' });
      processed++;
      continue;
    }

    // Check policy
    let policyMode: string = 'approval_required';
    try {
      const policy = await getPolicy(post.business_id, post.connector_id);
      policyMode = policy.mode;
    } catch {
      // Can't read policy — revert without consuming an attempt (claimPost already incremented;
      // decrement it back so we don't count a policy-read failure as a publish attempt)
      db.prepare(`
        UPDATE social_posts
        SET status = 'approved', attempt_count = attempt_count - 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND business_id = ?
      `).run('Policy read failed — will retry next tick.', post.id, post.business_id);
      continue;
    }

    if (policyMode === 'drafts_only') {
      markPermanentFailure(post.id, post.business_id, 'Policy is drafts_only — scheduled publishing is not permitted.');
      writeAudit(post.business_id, post.id, post.connector_id, 'blocked', { reason: 'Policy is drafts_only' });
      processed++;
      continue;
    }

    // attempt_count was already incremented by claimPost above
    writeAudit(post.business_id, post.id, post.connector_id, 'attempted', {
      scheduledAt: post.scheduled_at,
      attemptNumber: post.attempt_count + 1, // +1 because post.attempt_count is the pre-claim value
    });

    // Get page access token for Facebook Page publishing
    const pageAccessToken = post.platform === 'facebook'
      ? getPageAccessToken(post.connector_id, post.business_id)
      : undefined;

    try {
      // Pass alreadyClaimed:true so publishNow does NOT increment attempt_count again.
      // The post is already in 'publishing' status from claimPost above.
      const updated = await publishNow(post.id, post.business_id, accessToken, {
        alreadyClaimed: true,
        pageAccessToken,
      });

      if (updated.status === 'published') {
        writeAudit(post.business_id, post.id, post.connector_id, 'succeeded', {
          externalId: updated.externalId,
          permalink: updated.permalink,
          verifiedAt: updated.verifiedAt,
        });
      } else if (updated.status === 'failed') {
        writeAudit(post.business_id, post.id, post.connector_id, 'failed', {
          lastError: updated.lastError,
          attemptCount: updated.attemptCount,
        });
      } else if (updated.status === 'draft') {
        // Transient error: publishNow reverted to draft. Re-approve for retry if within budget.
        if (updated.attemptCount < MAX_ATTEMPTS) {
          db.prepare(`
            UPDATE social_posts SET status = 'approved', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND business_id = ? AND status = 'draft'
          `).run(post.id, post.business_id);
        } else {
          markPermanentFailure(post.id, post.business_id, `Max retry attempts (${MAX_ATTEMPTS}) exceeded after transient errors.`);
          writeAudit(post.business_id, post.id, post.connector_id, 'failed', {
            reason: 'Max attempts exhausted',
            attemptCount: updated.attemptCount,
          });
        }
      }
    } catch (err) {
      // Unexpected error — revert to approved for retry
      revertToApproved(post.id, post.business_id, (err as Error).message ?? 'Unexpected error');
    }

    processed++;
  }

  return processed;
}
