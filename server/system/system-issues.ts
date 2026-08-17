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
  return getSystemIssue(id) as SystemIssue;
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
  // Global issues (business_id IS NULL — e.g. the shared monthly LLM budget)
  // are relevant context regardless of which business you're looking at, so
  // they're always included alongside a business's own scoped issues rather
  // than requiring a second, separate query to ever see them.
  if (filter.business_id) { clauses.push('(business_id = ? OR business_id IS NULL)'); values.push(filter.business_id); }
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
