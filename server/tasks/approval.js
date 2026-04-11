import db, { generateId } from '../db/db.js';
import { approveTask, updateTaskStatus } from './task-queue.js';
import { sendApprovalRequest as telegramApprovalRequest } from '../notifications/telegram.js';

/**
 * Determine whether a task should be auto-approved.
 */
export function shouldAutoApprove(task) {
  return task.trust_tier === 'green' && task.approval_mode === 'auto';
}

/**
 * Send an approval request notification for a task.
 * Routes to all configured channels (currently Telegram + DB notification).
 *
 * @param {Object} task
 * @param {Object} business
 */
export async function sendApprovalRequest(task, business) {
  const channels = [];

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
    console.error('[approval] Failed to create dashboard notification:', err.message);
  }

  // Send via Telegram if configured
  const telegramEnabled = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
  if (telegramEnabled) {
    try {
      await telegramApprovalRequest(task, business);
      channels.push('telegram');
    } catch (err) {
      console.error('[approval] Telegram notification failed:', err.message);
    }
  }

  return { channels };
}

/**
 * Process tasks where timed approval has expired — auto-approve them.
 * Designed to run on a schedule (every 5 minutes).
 */
export async function processTimedApproval() {
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
  `).all(now);

  const results = [];
  for (const task of timedTasks) {
    try {
      const approved = approveTask(task.id, 'system:timed-approval');
      results.push({ taskId: task.id, status: 'approved' });
      console.log(`[approval] Timed auto-approval executed for task ${task.id}`);
    } catch (err) {
      console.error(`[approval] Timed approval failed for task ${task.id}:`, err.message);
      results.push({ taskId: task.id, status: 'error', error: err.message });
    }
  }

  return results;
}

function mapSeverity(trustTier) {
  switch (trustTier) {
    case 'green': return 'info';
    case 'yellow': return 'warning';
    case 'red': return 'critical';
    default: return 'warning';
  }
}
