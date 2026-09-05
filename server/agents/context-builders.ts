/**
 * Shared context builders used by both the scheduled agent runner
 * and the chat engine so both see identical, current business data.
 */

import type { Database } from 'bun:sqlite';
import { explainConnectorHealth } from '../connectors/health.js';
import { getRankedRecommendations } from '../brain/recommendation-engine.js';
import { listPendingDecisions } from '../decisions/decision-queue.js';
import { redactSensitive, redactSensitiveText } from '../lib/redaction.js';

interface MetricsContextOptions {
  maxAgeHours?: number;
  maxPerConnector?: number;
}

interface MetricRow {
  connector_type: string;
  connector_name: string;
  metric_name: string;
  metric_value: string;
  recorded_at: string;
}

interface ConnectorGroup {
  name: string;
  metrics: Array<{ name: string; value: string; at: string }>;
}

type SnapshotError = { code: string; message: string };

interface SnapshotSection<T> {
  as_of: string;
  data_as_of: string | null;
  partial: boolean;
  error: SnapshotError | null;
  data: T;
}

interface SnapshotConnectorRow {
  id: string;
  type: string;
  name: string;
  status: string;
  last_sync: string | null;
  last_error: string | null;
  health: ReturnType<typeof explainConnectorHealth>;
}

interface SnapshotCounts {
  total: number;
  by_status?: Record<string, number>;
  by_severity?: Record<string, number>;
  by_lane?: Record<string, number>;
}

export interface PreLLMContextSnapshot {
  kind: 'blueprint.pre_llm_context_snapshot.v1';
  business_id: string;
  agent_id: string;
  trigger: string;
  trigger_id: string | null;
  as_of: string;
  data_as_of: string | null;
  partial: boolean;
  error: SnapshotError | null;
  sections: {
    connectors: SnapshotSection<{
      counts: SnapshotCounts & { by_health: Record<string, number> };
      connectors: SnapshotConnectorRow[];
    }>;
    command_centre_health: SnapshotSection<{
      agent_runs_24h: { total: number; failed: number; running: number; skipped: number };
      open_system_issues: Array<{ id: string; issue_type: string; severity: string; title: string; created_at: string; related_connector_id: string | null; related_task_id: string | null }>;
      open_system_issue_counts: SnapshotCounts & { by_type: Record<string, number> };
    }>;
    goals_tasks_signals_recommendations: SnapshotSection<{
      active_goals: Array<{ id: string; title: string; progress_pct: number | null; deadline: string | null; metric_name: string | null; metric_current: number | null; metric_target: number | null }>;
      at_risk_goals: Array<{ id: string; title: string; progress_pct: number | null; deadline: string | null }>;
      task_counts: SnapshotCounts;
      signal_counts: SnapshotCounts;
      top_recommendations: Array<{ id: string; source_type: string; title: string; score: number; confidence: number | null; has_open_conflict: boolean }>;
    }>;
    decisions_conflicts_outcomes: SnapshotSection<{
      pending_decisions: {
        counts: SnapshotCounts & { by_lane: Record<string, number> };
        sample: Array<{ task_id: string; title: string; lane: string; risk_tier: string; policy_recommendation: string; created_at: string }>;
      };
      open_conflicts: Array<{ id: string; conflict_type: string; severity: string; description: string; recommendation: string | null; detected_at: string }>;
      recent_decisions: Array<{ id: string; decision_type: string; title: string; decision: string; confidence: number | null; author: string; created_at: string }>;
      recent_outcomes: Array<{ id: string; task_id: string; verdict: string | null; change_pct: number | null; check_date: string; created_at: string }>;
    }>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw
    : raw.includes('T') ? `${raw}Z`
      : `${raw.replace(' ', 'T')}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function newestTimestamp(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = timestampMs(value);
    if (ms == null || ms <= bestMs) continue;
    bestMs = ms;
    best = value ?? null;
  }
  return best;
}

function countBy(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const label = String(row[key] ?? 'unknown');
    out[label] = (out[label] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sanitizeText(value: unknown, max = 240): string {
  return redactSensitiveText(String(value ?? '')).slice(0, max);
}

function section<T>(
  code: string,
  empty: T,
  compute: () => { data: T; data_as_of: string | null; partial?: boolean },
): SnapshotSection<T> {
  const as_of = nowIso();
  try {
    const result = compute();
    return {
      as_of,
      data_as_of: result.data_as_of,
      partial: result.partial ?? false,
      error: null,
      data: result.data,
    };
  } catch (err) {
    return {
      as_of,
      data_as_of: null,
      partial: true,
      error: { code, message: redactSensitiveText((err as Error)?.message ?? String(err)) },
      data: empty,
    };
  }
}

function sectionDataAsOf(section: SnapshotSection<unknown>): string | null {
  return section.data_as_of;
}

/**
 * Deterministic, read-only snapshot injected before an agent reasons.
 *
 * This deliberately reads only persisted Blueprint state. It does not sync
 * connectors, call providers, mutate inbox/read state, or approve work.
 * Every section reports when it was computed (`as_of`), the newest source
 * timestamp it rests on (`data_as_of`), and whether the section/top-level
 * snapshot is partial due to an isolated read error.
 */
export function buildPreLLMContextSnapshot(
  businessId: string,
  agentId: string,
  db: Database,
  opts: { trigger?: string; triggerId?: string | null } = {},
): PreLLMContextSnapshot {
  const trigger = opts.trigger ?? 'unknown';
  const triggerId = opts.triggerId ?? null;

  const connectors = section<PreLLMContextSnapshot['sections']['connectors']['data']>('connectors_snapshot_failed', { counts: { total: 0, by_status: {}, by_health: {} }, connectors: [] }, () => {
    const rows = db.prepare(`
      SELECT id, business_id, type, name, status, last_sync, last_error, config
      FROM connectors
      WHERE business_id = ?
      ORDER BY type ASC, name ASC, id ASC
    `).all(businessId) as Array<Record<string, unknown>>;
    const items: SnapshotConnectorRow[] = rows.map((row) => {
      const health = explainConnectorHealth(row as Parameters<typeof explainConnectorHealth>[0]);
      return {
        id: String(row.id),
        type: String(row.type),
        name: String(row.name),
        status: String(row.status),
        last_sync: (row.last_sync as string | null) ?? null,
        last_error: row.last_error ? sanitizeText(row.last_error) : null,
        health: redactSensitive(health, { maxStringLength: 300 }) as ReturnType<typeof explainConnectorHealth>,
      };
    });
    return {
      data_as_of: newestTimestamp([
        ...items.map((c) => c.last_sync),
        ...rows.map((r) => r.created_at as string | null),
      ]),
      data: {
        counts: {
          total: items.length,
          by_status: countBy(items as unknown as Array<Record<string, unknown>>, 'status'),
          by_health: countBy(items.map((c) => ({ state: c.health.state })), 'state'),
        },
        connectors: items,
      },
    };
  });

  const commandCentreHealth = section<PreLLMContextSnapshot['sections']['command_centre_health']['data']>('command_centre_health_snapshot_failed', {
    agent_runs_24h: { total: 0, failed: 0, running: 0, skipped: 0 },
    open_system_issues: [],
    open_system_issue_counts: { total: 0, by_status: {}, by_severity: {}, by_type: {} },
  }, () => {
    const runRows = db.prepare(`
      SELECT status, started_at, completed_at
      FROM agent_runs
      WHERE business_id = ? AND started_at > datetime('now', '-24 hours')
      ORDER BY started_at DESC
    `).all(businessId) as Array<{ status: string; started_at: string | null; completed_at: string | null }>;
    const issueRows = db.prepare(`
      SELECT id, issue_type, severity, title, related_connector_id, related_task_id, created_at, updated_at
      FROM system_issues
      WHERE (business_id = ? OR business_id IS NULL) AND status = 'open'
      ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 10
    `).all(businessId) as Array<Record<string, unknown>>;
    const issueCountRows = db.prepare(`
      SELECT status, severity, issue_type
      FROM system_issues
      WHERE (business_id = ? OR business_id IS NULL) AND status = 'open'
    `).all(businessId) as Array<Record<string, unknown>>;
    return {
      data_as_of: newestTimestamp([
        ...runRows.map((r) => r.completed_at ?? r.started_at),
        ...issueRows.map((r) => (r.updated_at as string | null) ?? (r.created_at as string | null)),
      ]),
      data: {
        agent_runs_24h: {
          total: runRows.length,
          failed: runRows.filter((r) => r.status === 'failed').length,
          running: runRows.filter((r) => r.status === 'running').length,
          skipped: runRows.filter((r) => r.status === 'skipped').length,
        },
        open_system_issues: issueRows.map((r) => ({
          id: String(r.id),
          issue_type: String(r.issue_type),
          severity: String(r.severity),
          title: sanitizeText(r.title),
          created_at: String(r.created_at),
          related_connector_id: (r.related_connector_id as string | null) ?? null,
          related_task_id: (r.related_task_id as string | null) ?? null,
        })),
        open_system_issue_counts: {
          total: issueCountRows.length,
          by_status: countBy(issueCountRows, 'status'),
          by_severity: countBy(issueCountRows, 'severity'),
          by_type: countBy(issueCountRows, 'issue_type'),
        },
      },
    };
  });

  const goalsTasksSignalsRecommendations = section<PreLLMContextSnapshot['sections']['goals_tasks_signals_recommendations']['data']>('goals_tasks_signals_recommendations_snapshot_failed', {
    active_goals: [],
    at_risk_goals: [],
    task_counts: { total: 0, by_status: {} },
    signal_counts: { total: 0, by_status: {}, by_severity: {} },
    top_recommendations: [],
  }, () => {
    const goalRows = db.prepare(`
      SELECT id, title, progress_pct, deadline, metric_name, metric_current, metric_target, updated_at, last_checked
      FROM goals
      WHERE business_id = ? AND status = 'active'
      ORDER BY (deadline IS NULL) ASC, deadline ASC, updated_at DESC
      LIMIT 10
    `).all(businessId) as Array<Record<string, unknown>>;
    const taskRows = db.prepare(`
      SELECT status, updated_at, created_at
      FROM tasks
      WHERE business_id = ? AND status IN ('proposed', 'approved', 'executing', 'manual_review', 'deferred')
    `).all(businessId) as Array<Record<string, unknown>>;
    const signalRows = db.prepare(`
      SELECT status, severity, created_at, resolved_at
      FROM signals
      WHERE business_id = ? AND status IN ('open', 'acknowledged')
    `).all(businessId) as Array<Record<string, unknown>>;
    const ranked = getRankedRecommendations(businessId, { limit: 5 }).recommendations;
    const activeGoals = goalRows.map((g) => ({
      id: String(g.id),
      title: sanitizeText(g.title, 180),
      progress_pct: g.progress_pct == null ? null : Number(g.progress_pct),
      deadline: (g.deadline as string | null) ?? null,
      metric_name: (g.metric_name as string | null) ?? null,
      metric_current: g.metric_current == null ? null : Number(g.metric_current),
      metric_target: g.metric_target == null ? null : Number(g.metric_target),
    }));
    const atRiskGoals = activeGoals.filter((g) => {
      if (!g.deadline) return false;
      const deadlineMs = timestampMs(g.deadline);
      if (deadlineMs == null) return false;
      const days = (deadlineMs - Date.now()) / 86400000;
      return days >= 0 && days <= 7 && (g.progress_pct ?? 0) < 70;
    });
    return {
      data_as_of: newestTimestamp([
        ...goalRows.map((g) => (g.last_checked as string | null) ?? (g.updated_at as string | null)),
        ...taskRows.map((t) => (t.updated_at as string | null) ?? (t.created_at as string | null)),
        ...signalRows.map((s) => (s.resolved_at as string | null) ?? (s.created_at as string | null)),
      ]),
      data: {
        active_goals: activeGoals,
        at_risk_goals: atRiskGoals,
        task_counts: { total: taskRows.length, by_status: countBy(taskRows, 'status') },
        signal_counts: {
          total: signalRows.length,
          by_status: countBy(signalRows, 'status'),
          by_severity: countBy(signalRows, 'severity'),
        },
        top_recommendations: ranked.map((r) => ({
          id: r.id,
          source_type: r.source_type,
          title: sanitizeText(r.title, 180),
          score: r.score,
          confidence: r.confidence ?? null,
          has_open_conflict: r.has_open_conflict,
        })),
      },
    };
  });

  const decisionsConflictsOutcomes = section<PreLLMContextSnapshot['sections']['decisions_conflicts_outcomes']['data']>('decisions_conflicts_outcomes_snapshot_failed', {
    pending_decisions: { counts: { total: 0, by_lane: {} }, sample: [] },
    open_conflicts: [],
    recent_decisions: [],
    recent_outcomes: [],
  }, () => {
    const pending = listPendingDecisions(businessId, { limit: 20 });
    const conflictRows = db.prepare(`
      SELECT id, conflict_type, severity, description, recommendation, detected_at
      FROM conflicts
      WHERE business_id = ? AND status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, detected_at DESC
      LIMIT 10
    `).all(businessId) as Array<Record<string, unknown>>;
    const decisionRows = db.prepare(`
      SELECT id, decision_type, title, decision, confidence, author, created_at
      FROM decisions
      WHERE business_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(businessId) as Array<Record<string, unknown>>;
    const outcomeRows = db.prepare(`
      SELECT o.id, o.task_id, o.verdict, o.change_pct, o.check_date, o.created_at
      FROM task_outcomes o
      JOIN tasks t ON t.id = o.task_id
      WHERE t.business_id = ?
      ORDER BY o.created_at DESC, o.check_date DESC
      LIMIT 10
    `).all(businessId) as Array<Record<string, unknown>>;
    const byLane = Object.fromEntries(
      Object.entries(pending.counts).filter(([lane]) => lane !== 'total')
    ) as Record<string, number>;
    return {
      data_as_of: newestTimestamp([
        ...pending.decisions.map((d) => d.updated_at ?? d.created_at),
        ...conflictRows.map((c) => c.detected_at as string | null),
        ...decisionRows.map((d) => d.created_at as string | null),
        ...outcomeRows.map((o) => (o.created_at as string | null) ?? (o.check_date as string | null)),
      ]),
      data: {
        pending_decisions: {
          counts: {
            total: pending.counts.total,
            by_lane: byLane,
          },
          sample: pending.decisions.slice(0, 5).map((d) => ({
            task_id: d.task_id,
            title: sanitizeText(d.title, 180),
            lane: d.lane,
            risk_tier: d.risk_tier,
            policy_recommendation: d.policy_recommendation,
            created_at: d.created_at,
          })),
        },
        open_conflicts: conflictRows.map((c) => ({
          id: String(c.id),
          conflict_type: String(c.conflict_type),
          severity: String(c.severity),
          description: sanitizeText(c.description, 300),
          recommendation: c.recommendation ? sanitizeText(c.recommendation, 240) : null,
          detected_at: String(c.detected_at),
        })),
        recent_decisions: decisionRows.map((d) => ({
          id: String(d.id),
          decision_type: String(d.decision_type),
          title: sanitizeText(d.title, 180),
          decision: sanitizeText(d.decision, 220),
          confidence: d.confidence == null ? null : Number(d.confidence),
          author: sanitizeText(d.author, 120),
          created_at: String(d.created_at),
        })),
        recent_outcomes: outcomeRows.map((o) => ({
          id: String(o.id),
          task_id: String(o.task_id),
          verdict: (o.verdict as string | null) ?? null,
          change_pct: o.change_pct == null ? null : Number(o.change_pct),
          check_date: String(o.check_date),
          created_at: String(o.created_at),
        })),
      },
    };
  });

  const sections = {
    connectors,
    command_centre_health: commandCentreHealth,
    goals_tasks_signals_recommendations: goalsTasksSignalsRecommendations,
    decisions_conflicts_outcomes: decisionsConflictsOutcomes,
  };
  const partial = Object.values(sections).some((s) => s.partial || s.error);
  const dataAsOf = newestTimestamp(Object.values(sections).map(sectionDataAsOf));

  return {
    kind: 'blueprint.pre_llm_context_snapshot.v1',
    business_id: businessId,
    agent_id: agentId,
    trigger,
    trigger_id: triggerId,
    as_of: nowIso(),
    data_as_of: dataAsOf,
    partial,
    error: partial ? { code: 'partial_snapshot', message: 'One or more pre-LLM snapshot sections could not be fully assembled.' } : null,
    sections,
  };
}

export function formatPreLLMContextSnapshot(snapshot: PreLLMContextSnapshot): string {
  return [
    '## Blueprint Pre-LLM Context Snapshot',
    'This deterministic read-only snapshot was assembled before reasoning. Respect section-level as_of/data_as_of/partial/error fields; if partial is true, treat missing sections as unknown rather than healthy.',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
  ].join('\n');
}

/**
 * Build a formatted "Current Business Data" section from the metrics table.
 *
 * Groups metrics by connector type, deduplicates to the latest value per
 * metric name, and returns a ready-to-embed string for system prompts.
 * Returns an empty string if no recent metrics exist.
 *
 * @param businessId
 * @param db
 * @param opts
 */
export function buildMetricsContext(
  businessId: string,
  db: Database,
  opts: MetricsContextOptions = {}
): string {
  const maxAgeHours     = opts.maxAgeHours    ?? 48;
  const maxPerConnector = opts.maxPerConnector ?? 30;

  const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  let rows: MetricRow[];
  try {
    rows = db.prepare(`
      SELECT
        c.type      AS connector_type,
        c.name      AS connector_name,
        m.metric_name,
        m.metric_value,
        m.recorded_at
      FROM metrics m
      JOIN connectors c ON c.id = m.connector_id
      WHERE m.business_id = ?
        AND m.recorded_at >= ?
        AND m.metric_value IS NOT NULL
      ORDER BY m.recorded_at DESC
    `).all(businessId, since) as Array<MetricRow>;
  } catch {
    return '';
  }

  if (!rows.length) return '';

  // Group by connector type, keep only the latest value per metric name
  const byConnector: Record<string, ConnectorGroup> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.connector_type}::${row.metric_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byConnector[row.connector_type]) {
      byConnector[row.connector_type] = { name: row.connector_name, metrics: [] };
    }
    byConnector[row.connector_type]!.metrics.push({
      name:  row.metric_name,
      value: row.metric_value,
      at:    row.recorded_at,
    });
  }

  const sections: string[] = [];
  for (const [type, { name, metrics }] of Object.entries(byConnector)) {
    const capped  = metrics.slice(0, maxPerConnector);
    const omitted = metrics.length - capped.length;
    const label   = name && name !== type ? `${type} (${name})` : type;
    const lines   = capped.map(m => `  ${m.name}: ${m.value}`);
    if (omitted > 0) lines.push(`  … ${omitted} more metrics available`);
    sections.push(`### ${label.toUpperCase()}\n${lines.join('\n')}`);
  }

  return `## Current Business Data

This is real, live data pulled from your connected sources.
Use these numbers when answering questions or proposing tasks.
Do not ask the user to share data that is already listed here.

${sections.join('\n\n')}`;
}
