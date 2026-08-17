/**
 * Blueprint System Issues.
 *
 * Raised whenever Blueprint decides NOT to do something a human might
 * expect it to do — a task can't be validated for execution, a connector's
 * confidence is too low to trust, an outcome measurement shows no
 * improvement — instead of silently dropping the work or (worse) doing it
 * anyway. This is the audit trail for "why didn't Blueprint act".
 */
import db, { generateId } from '../db/db.js';

export type SystemIssueSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SystemIssueStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface SystemIssue {
  id: string;
  business_id: string | null;
  issue_type: string;
  severity: SystemIssueSeverity;
  title: string;
  description: string | null;
  related_task_id: string | null;
  related_connector_id: string | null;
  related_action_type: string | null;
  status: SystemIssueStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CreateSystemIssueParams {
  business_id?: string | null;
  issue_type: string;
  severity?: SystemIssueSeverity;
  title: string;
  description?: string | null;
  related_task_id?: string | null;
  related_connector_id?: string | null;
  related_action_type?: string | null;
  metadata?: Record<string, unknown>;
}

function parseRow(row: Record<string, unknown>): SystemIssue {
  return {
    ...row,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : {},
  } as unknown as SystemIssue;
}

export function createSystemIssue(params: CreateSystemIssueParams): SystemIssue {
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO system_issues (
      id, business_id, issue_type, severity, title, description,
      related_task_id, related_connector_id, related_action_type, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(
    id,
    params.business_id ?? null,
    params.issue_type,
    params.severity ?? 'warning',
    params.title,
    params.description ?? null,
    params.related_task_id ?? null,
    params.related_connector_id ?? null,
    params.related_action_type ?? null,
    JSON.stringify(params.metadata ?? {}),
    now, now,
  );
  const issue = getSystemIssue(id) as SystemIssue;
  notifyIfSevereEnough(issue);
  return issue;
}

const SEVERITY_RANK: Record<SystemIssueSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

/**
 * Operator-tunable floor for "page a human", read fresh on every call (not
 * cached) so a change takes effect immediately, matching how
 * cost_monthly_budget_usd/cost_cap_daily_usd are read in agent-runner.ts.
 * Defaults to 'error': every current call site raises 'warning' for things
 * a human doesn't need to be paged for (a single task blocked by policy,
 * one payload validation failure) — those still land in the dashboard's
 * System Issues view, just without a proactive push. An operator who wants
 * warnings pushed too can lower this by writing
 * settings.system_issue_notify_min_severity = '"warning"'.
 */
function getNotifyThreshold(): SystemIssueSeverity {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'system_issue_notify_min_severity'").get() as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'string' && parsed in SEVERITY_RANK) return parsed as SystemIssueSeverity;
    }
  } catch {}
  return 'error';
}

/**
 * The one place every createSystemIssue() caller gets proactive notification
 * for free — task-queue.ts, agent-runner.ts, webhook-reconciliation.ts, and
 * any future caller, without each of them wiring dispatch() themselves.
 * Dynamic import breaks a real module cycle: dispatcher.ts -> telegram.ts ->
 * task-queue.ts -> system-issues.ts would deadlock a static import at
 * load time. Fire-and-forget (not awaited) because createSystemIssue()
 * itself is synchronous and used that way at every call site — a Telegram
 * delivery failure must never make raising the issue itself fail; the
 * system_issues row above is the durable record regardless of whether
 * this notification ever lands.
 */
function notifyIfSevereEnough(issue: SystemIssue): void {
  if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[getNotifyThreshold()]) return;
  import('../notifications/dispatcher.js')
    .then(({ dispatchToAll }) => dispatchToAll(['dashboard', 'telegram'], {
      business_id: issue.business_id ?? undefined,
      severity: issue.severity,
      title: issue.title,
      body: issue.description ?? undefined,
      entity_type: 'system_issue',
      entity_id: issue.id,
    }))
    .catch((err: Error) => console.error('[system-issues] notify dispatch failed (non-fatal):', err.message));
}

export function getSystemIssue(id: string): SystemIssue | null {
  const row = db.prepare('SELECT * FROM system_issues WHERE id = ?').get(id) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export interface ListSystemIssuesFilter {
  business_id?: string;
  status?: SystemIssueStatus;
  issue_type?: string;
  limit?: number;
}

export function listSystemIssues(filter: ListSystemIssuesFilter = {}): SystemIssue[] {
  const clauses: string[] = [];
  const values: any[] = [];
  if (filter.business_id) { clauses.push('business_id = ?'); values.push(filter.business_id); }
  if (filter.status) { clauses.push('status = ?'); values.push(filter.status); }
  if (filter.issue_type) { clauses.push('issue_type = ?'); values.push(filter.issue_type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = db.prepare(`SELECT * FROM system_issues ${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit) as Record<string, unknown>[];
  return rows.map(parseRow);
}

export function updateSystemIssueStatus(id: string, status: SystemIssueStatus): SystemIssue | null {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE system_issues SET status = ?, updated_at = ?, resolved_at = CASE WHEN ? IN ('resolved','dismissed') THEN ? ELSE resolved_at END
    WHERE id = ?
  `).run(status, now, status, now, id);
  return getSystemIssue(id);
}
