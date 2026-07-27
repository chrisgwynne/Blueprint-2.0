import db, { generateId } from '../db/db.js';
import { approveTask } from './task-queue.js';
import { getBusinessProfile } from '../business/business-profile.js';

export interface TaskRow {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  status: string;
  trust_tier: string;
  priority: string;
  proposed_by: string;
  action_type: string | null;
  action_payload: unknown;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  approval_mode?: string | null;
}

export interface BusinessRow {
  id: string;
  name: string;
  slug?: string;
}

type ApprovalPolicy = 'auto' | 'manual';
type ApprovalPolicies = Record<string, ApprovalPolicy>;

/**
 * Action types that are destructive, irreversible, or outward-facing. These can
 * NEVER be auto-approved and their trust tier is always forced to 'red' at task
 * creation (see agent-runner). This is the server-owned safety floor: neither a
 * settings policy nor a model-supplied trust_tier can lower the gate on these.
 */
export const DANGEROUS_ACTION_TYPES = new Set<string>([
  'server_file_write',
  'server_file_rollback',
  'shopify_theme_edit',
  'shopify_product_create',
  'shopify_page_create',
  'shopify_blog_post_create',
  'github_pr',
  'github_review_deploy',
  'wix_seo_update',
  'delete_product',
]);

/**
 * Read the user-configurable approval policies from the settings table.
 * Shape: { default?: 'auto' | 'manual', <action_type>?: 'auto' | 'manual' }
 */
function readApprovalPolicies(): ApprovalPolicies {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'approval_policies'").get() as { value: string } | null;
    if (!row?.value) return {};
    const parsed: unknown = JSON.parse(row.value);
    return (typeof parsed === 'object' && parsed !== null) ? parsed as ApprovalPolicies : {};
  } catch {
    return {};
  }
}

/**
 * Determine whether a task should be auto-approved.
 *
 * Order of precedence:
 *   1. This business's Business Profile approval_policy (Business Truth
 *      Layer, per-business — more specific than the instance-wide
 *      Settings policy below, so it's consulted first)
 *   2. Per-action-type policy from Settings → Approval Policies
 *   3. Default policy from same Settings tab
 *   4. Legacy fallback: trust_tier === 'green' && approval_mode === 'auto'
 */
export function shouldAutoApprove(task: TaskRow): boolean {
  // Hard floor: destructive / outward-facing actions are never auto-approved,
  // regardless of any settings policy or trust tier. A blanket
  // `default: 'auto'` policy (or an over-eager / injected model) must not be
  // able to execute an irreversible change unattended.
  if (task.action_type && DANGEROUS_ACTION_TYPES.has(task.action_type)) return false;

  const profile = getBusinessProfile(task.business_id);
  if (profile && task.action_type) {
    if (profile.approval_policy.always_require_approval?.includes(task.action_type)) return false;
    if (profile.approval_policy.allow_auto_approve?.includes(task.action_type)) return true;
  }
  if (profile?.approval_policy.default_mode === 'manual') return false;
  if (profile?.approval_policy.default_mode === 'auto') return true;

  const policies = readApprovalPolicies();
  const perAction = task.action_type ? policies[task.action_type] : undefined;
  if (perAction === 'auto') return true;
  if (perAction === 'manual') return false;
  if (policies['default'] === 'auto') return true;
  if (policies['default'] === 'manual') return false;
  return task.trust_tier === 'green' && task.approval_mode === 'auto';
}

/**
 * Send an approval request notification for a task.
 * Routes to all configured channels (currently Telegram + DB notification).
 */
export async function sendApprovalRequest(task: TaskRow, business: BusinessRow): Promise<{ channels: string[] }> {
  const channels: string[] = [];

  // Insert a notification record in the DB
  const notifId = generateId();
  try {
    db.prepare(`
      INSERT INTO notifications (id, business_id, channel, severity, title, body, entity_type, entity_id, created_at)
      VALUES (?, ?, 'dashboard', ?, ?, ?, 'task', ?, CURRENT_TIMESTAMP)
    `).run(
      notifId,
      business.id,
      mapSeverity(task.trust_tier),
      `Approval required: ${task.title}`,
      task.description ?? '',
      task.id
    );
    channels.push('dashboard');
  } catch (err) {
    console.error('[approval] Failed to create dashboard notification:', (err as Error).message);
  }

  // Send via Telegram if configured
  const telegramEnabled = process.env['TELEGRAM_BOT_TOKEN'] && process.env['TELEGRAM_CHAT_ID'];
  if (telegramEnabled) {
    try {
      const { sendApprovalRequest: telegramApprovalRequest } = await import('../notifications/telegram.js') as unknown as {
        sendApprovalRequest: (task: TaskRow, business: BusinessRow) => Promise<void>;
      };
      await telegramApprovalRequest(task, business);
      channels.push('telegram');
    } catch (err) {
      console.error('[approval] Telegram notification failed:', (err as Error).message);
    }
  }

  return { channels };
}

interface TimedApprovalResult {
  taskId: string;
  status: 'approved' | 'error';
  error?: string;
}

/**
 * Process tasks where timed approval has expired — auto-approve them.
 * Designed to run on a schedule (every 5 minutes).
 */
export async function processTimedApproval(): Promise<TimedApprovalResult[]> {
  const now = new Date().toISOString();

  // Find tasks that have a timed approval window that has passed
  const timedTasks = db.prepare(`
    SELECT t.* FROM tasks t
    JOIN (
      SELECT entity_id, MAX(json_extract(metadata, '$.approve_after')) as approve_after
      FROM audit_log
      WHERE entity_type = 'task' AND action = 'create'
      GROUP BY entity_id
    ) al ON al.entity_id = t.id
    WHERE t.status = 'proposed'
      AND al.approve_after IS NOT NULL
      AND al.approve_after <= ?
  `).all(now) as Array<{ id: string }>;

  const results: TimedApprovalResult[] = [];
  for (const task of timedTasks) {
    try {
      approveTask(task.id, 'system:timed-approval');
      results.push({ taskId: task.id, status: 'approved' });
      console.log(`[approval] Timed auto-approval executed for task ${task.id}`);
    } catch (err) {
      console.error(`[approval] Timed approval failed for task ${task.id}:`, (err as Error).message);
      results.push({ taskId: task.id, status: 'error', error: (err as Error).message });
    }
  }

  return results;
}

function mapSeverity(trustTier: string): string {
  switch (trustTier) {
    case 'green': return 'info';
    case 'yellow': return 'warning';
    case 'red': return 'critical';
    default: return 'warning';
  }
}
