/**
 * Blueprint Notification Adapter Interface
 *
 * All notification adapters (Telegram, Email, Slack, etc.) must implement
 * the shape defined in this file.
 *
 * ─── Notification Object Shape ───────────────────────────────────────────────
 *
 * {
 *   id: string              Unique notification ID (from DB)
 *   business_id: string     Business this notification belongs to
 *   channel: string         'telegram' | 'email' | 'dashboard' | 'slack'
 *   severity: string        'info' | 'warning' | 'alert' | 'critical'
 *   title: string           Short notification title
 *   body: string            Full notification body / message
 *   entity_type: string     'task' | 'signal' | 'agent_run' | 'system'
 *   entity_id: string       ID of the related entity
 * }
 *
 * ─── Required Methods ────────────────────────────────────────────────────────
 *
 * send(notification)
 *   Send a plain notification message.
 *   @param {Object} notification - Notification object as above
 *   @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 *
 * sendApprovalRequest(task, business)
 *   Send a task approval request with interactive Approve/Reject buttons.
 *   @param {Object} task - Task object from DB
 *   @param {Object} business - Business object from DB
 *   @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 *
 * ─── Severity to Visual Mapping ─────────────────────────────────────────────
 *
 * info     → 🔵 Blue   — informational, no action required
 * warning  → 🟡 Yellow — something to be aware of, may need attention
 * alert    → 🟠 Orange — requires attention, degraded state
 * critical → 🔴 Red    — urgent, requires immediate action
 */

export const SEVERITY_ICONS: Record<string, string> = {
  info: '🔵',
  warning: '🟡',
  alert: '🟠',
  critical: '🔴',
};

export const CHANNEL_IDS = {
  TELEGRAM: 'telegram',
  EMAIL: 'email',
  DASHBOARD: 'dashboard',
  SLACK: 'slack',
};

/**
 * Base adapter — all adapters extend this conceptually.
 * In practice, adapters export plain objects with the required methods.
 */
export class NotificationAdapter {
  get channelId(): string {
    throw new Error('Adapter must define channelId getter.');
  }

  async send(notification: any): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    throw new Error('send() not implemented.');
  }

  async sendApprovalRequest(task: any, business: any): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    throw new Error('sendApprovalRequest() not implemented.');
  }
}
