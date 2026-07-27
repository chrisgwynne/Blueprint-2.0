/**
 * Brain — Cross-Business Learning (Phase 3).
 *
 * "SEO improvement worked on Business A — applicable to Business B."
 * Aggregates task_outcomes across every business on this instance, grouped
 * by action_type, into abstract, non-identifying patterns any business's
 * agents can consult.
 *
 * No business_id, business name, URL, task title, or any other
 * tenant-identifying value is ever written to cross_business_patterns —
 * enforced structurally (the table has no such column at all — see
 * db.ts's Phase 3 migration comment), not by a redaction pass that could
 * be bypassed by a future careless call site. Only the action_type, an
 * aggregate success rate, a sample size, and the distinct set of business
 * *types* (e.g. "ecommerce", "saas" — never names) that contributed data
 * are stored.
 */
import crypto from 'crypto';
import db from '../db/db.js';
import { computeOutcomeStatus } from '../tasks/outcome-status.js';

export interface CrossBusinessPattern {
  pattern_key: string;
  action_type: string;
  description: string;
  sample_size: number;
  success_count: number;
  success_rate: number | null;
  applicable_business_types: string[];
}

/**
 * Recomputes every pattern from current data. Call after outcome
 * measurement runs, or on a schedule / via the BAP retrospective trigger —
 * it's a full recompute (not incremental), which is fine at this data
 * scale and avoids drift between incremental updates and reality.
 */
export function updateCrossBusinessPatterns(): CrossBusinessPattern[] {
  // task.id is selected only to group each task's checks together within
  // this function's transient in-memory aggregation — it is never part of
  // what gets written to cross_business_patterns (see the INSERT below,
  // which has no task/business identifier columns at all).
  const rows = db.prepare(`
    SELECT t.id AS task_id, t.action_type, t.status, t.completed_at, o.weeks_after, o.verdict, b.type AS business_type
    FROM tasks t
    JOIN task_outcomes o ON o.task_id = t.id
    JOIN businesses b ON b.id = t.business_id
    WHERE t.action_type IS NOT NULL AND t.target_metric IS NOT NULL
  `).all() as Array<{ task_id: string; action_type: string; status: string; completed_at: string | null; weeks_after: number; verdict: string | null; business_type: string | null }>;

  type TaskAgg = { action_type: string; status: string; completed_at: string | null; business_type: string | null; checks: Array<{ weeks_after: number; verdict: string | null }> };
  const byTaskId = new Map<string, TaskAgg>();
  for (const r of rows) {
    if (!byTaskId.has(r.task_id)) {
      byTaskId.set(r.task_id, { action_type: r.action_type, status: r.status, completed_at: r.completed_at, business_type: r.business_type, checks: [] });
    }
    byTaskId.get(r.task_id)!.checks.push({ weeks_after: r.weeks_after, verdict: r.verdict });
  }

  type Bucket = { tasks: TaskAgg[]; businessTypes: Set<string> };
  const byActionType: Record<string, Bucket> = {};
  for (const task of byTaskId.values()) {
    if (!byActionType[task.action_type]) byActionType[task.action_type] = { tasks: [], businessTypes: new Set() };
    const bucket = byActionType[task.action_type]!;
    task.checks.sort((a, b) => a.weeks_after - b.weeks_after);
    bucket.tasks.push(task);
    if (task.business_type) bucket.businessTypes.add(task.business_type);
  }

  const patterns: CrossBusinessPattern[] = [];
  for (const [actionType, bucket] of Object.entries(byActionType)) {
    let successCount = 0;
    let finalCount = 0;
    for (const task of bucket.tasks) {
      const result = computeOutcomeStatus({ task_status: task.status, target_metric: 'x', completed_at: task.completed_at, checks: task.checks });
      if (!result.is_final) continue;
      finalCount++;
      if (result.status === 'successful') successCount++;
    }
    if (finalCount === 0) continue;

    const patternKey = `outcome.${actionType}`;
    const successRate = Math.round((successCount / finalCount) * 1000) / 1000;
    const description = `Across all businesses using Blueprint, "${actionType}" actions succeeded ${Math.round(successRate * 100)}% of the time (${successCount}/${finalCount} final outcomes).`;
    const businessTypes = Array.from(bucket.businessTypes);

    db.prepare(`
      INSERT INTO cross_business_patterns (id, pattern_key, action_type, category, description, sample_size, success_count, success_rate, applicable_business_types, last_updated, created_at)
      VALUES (?, ?, ?, 'outcome', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(pattern_key) DO UPDATE SET
        description = excluded.description, sample_size = excluded.sample_size,
        success_count = excluded.success_count, success_rate = excluded.success_rate,
        applicable_business_types = excluded.applicable_business_types, last_updated = CURRENT_TIMESTAMP
    `).run(crypto.randomUUID(), patternKey, actionType, description, finalCount, successCount, successRate, JSON.stringify(businessTypes));

    patterns.push({ pattern_key: patternKey, action_type: actionType, description, sample_size: finalCount, success_count: successCount, success_rate: successRate, applicable_business_types: businessTypes });
  }

  return patterns;
}

function parsePatternRow(row: Record<string, unknown>): CrossBusinessPattern {
  let types: string[] = [];
  try { types = JSON.parse((row.applicable_business_types as string) || '[]'); } catch {}
  return {
    pattern_key: row.pattern_key as string, action_type: row.action_type as string,
    description: row.description as string, sample_size: row.sample_size as number,
    success_count: row.success_count as number, success_rate: row.success_rate as number | null,
    applicable_business_types: types,
  };
}

export function listCrossBusinessPatterns(businessType?: string | null): CrossBusinessPattern[] {
  const rows = db.prepare('SELECT * FROM cross_business_patterns ORDER BY sample_size DESC').all() as Array<Record<string, unknown>>;
  const parsed = rows.map(parsePatternRow);
  if (!businessType) return parsed;
  return parsed.filter((p) => p.applicable_business_types.length === 0 || p.applicable_business_types.includes(businessType));
}

export function getCrossBusinessPattern(actionType: string): CrossBusinessPattern | null {
  const row = db.prepare('SELECT * FROM cross_business_patterns WHERE action_type = ?').get(actionType) as Record<string, unknown> | undefined;
  return row ? parsePatternRow(row) : null;
}
