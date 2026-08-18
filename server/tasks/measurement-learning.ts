import { spawn } from 'node:child_process';
import db, { generateId } from '../db/db.js';
import { getActionRegistryEntry } from './action-registry.js';

export type ServiceVerdict = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'INCONCLUSIVE' | 'NOT_MEASURABLE';

type EvidenceStatus = 'verified' | 'observed' | 'inferred' | 'blocked' | 'unknown';

interface TaskRow {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  status: string | null;
  proposed_by: string | null;
  action_type: string | null;
  action_payload: string | null;
  target_metric: string | null;
  target_metric_baseline: number | null;
  expected_outcome: string | null;
  external_baseline_snapshot: string | null;
  measurement_policy_id: string | null;
  completed_at: string | null;
  confidence: number | null;
}

interface MetricRow {
  connector_id: string;
  metric_name: string;
  metric_value: number | null;
  metric_data: string | null;
  period_start: string | null;
  period_end: string | null;
  recorded_at: string | null;
}

interface MeasurementRunRow {
  id: string;
  task_id: string;
  business_id: string;
  policy_id: string | null;
  checkpoint_at: string;
  checkpoint_day: number;
  state: string;
  baseline_value: number | null;
  observed_value: number | null;
  verdict: string | null;
  evidence_status: string | null;
  diagnostic: string | null;
}

interface MeasurementPolicyRow {
  id: string;
  business_id: string | null;
  action_type: string | null;
  metric_name: string | null;
  checkpoints_json: string | null;
  minimum_meaningful_change: number | null;
}

export interface MeasurementCompletion {
  run_id: string;
  task_id: string;
  service_verdict: ServiceVerdict;
  db_verdict: string;
  state: string;
  evidence_status: EvidenceStatus;
  confidence: number;
  quiet_notification: true;
  diagnostic: string;
  metric_name: string | null;
  baseline_value: number | null;
  observed_value: number | null;
  change_pct: number | null;
}

const LOWER_IS_BETTER_PATTERNS = [
  /(^|\.)lcp(_ms)?$/i,
  /(^|\.)inp(_ms)?$/i,
  /(^|\.)cls$/i,
  /(^|\.)bounce_rate$/i,
  /(^|\.)avg_position$/i,
  /(^|\.)cpc$/i,
  /(^|\.)cpm$/i,
  /(^|\.)error_rate$/i,
  /(^|\.)latency/i,
];

const DOMAIN_METRIC_OVERRIDES: Record<string, string> = {
  meta_update: 'gsc.avg_ctr',
  shopify_meta_update: 'gsc.avg_ctr',
  content_draft: 'gsc.total_clicks',
  github_pr: 'pagespeed.mobile.performance_score',
  github_review_deploy: 'pagespeed.mobile.performance_score',
  shopify_description_update: 'ga4.sessions',
  social_post: 'buffer.engagement_rate',
  buffer_post: 'buffer.engagement_rate',
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /bearer\s+|sk-|token=|api[_-]?key/i.test(value)) return '[redacted]';
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|api[_-]?key|authorization|password|credential|cookie/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(raw);
    }
  }
  return out;
}

function latestMetric(businessId: string, metricName: string): MetricRow | null {
  return db.prepare(`
    SELECT connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at
    FROM metrics
    WHERE business_id = ? AND metric_name = ? AND metric_value IS NOT NULL
    ORDER BY recorded_at DESC
    LIMIT 1
  `).get(businessId, metricName) as MetricRow | null;
}

function getTask(taskId: string): TaskRow | null {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | null;
}

function getPolicy(businessId: string, actionType?: string | null, metricName?: string | null): MeasurementPolicyRow {
  const exact = db.prepare(`
    SELECT * FROM measurement_policies
    WHERE active = 1
      AND (business_id = ? OR business_id IS NULL)
      AND (action_type = ? OR action_type IS NULL)
      AND (metric_name = ? OR metric_name IS NULL)
    ORDER BY business_id IS NULL ASC, action_type IS NULL ASC, metric_name IS NULL ASC
    LIMIT 1
  `).get(businessId, actionType ?? null, metricName ?? null) as MeasurementPolicyRow | null;
  return exact ?? {
    id: 'policy_default_immediate_7_28_90',
    business_id: null,
    action_type: null,
    metric_name: null,
    checkpoints_json: '[0,7,28,90]',
    minimum_meaningful_change: 0,
  };
}

function actionMemoryMetrics(taskId: string): string[] {
  const row = db.prepare('SELECT metrics_expected FROM action_memory WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as { metrics_expected: string | null } | null;
  return parseJson<string[]>(row?.metrics_expected, []).filter((m) => typeof m === 'string' && m.trim());
}

function isSocialTask(task: TaskRow): boolean {
  const text = `${task.action_type ?? ''} ${task.title ?? ''} ${task.description ?? ''} ${task.action_payload ?? ''}`.toLowerCase();
  return /\bsocial\b|buffer|instagram|facebook|linkedin|caption|post\b/.test(text);
}

function socialMetricCandidates(task: TaskRow): string[] {
  const payload = parseJson<Record<string, unknown>>(task.action_payload, {});
  const platform = String(payload.platform ?? payload.service ?? payload.channel ?? '').toLowerCase();
  return [
    platform ? `${platform}.engagement_rate` : null,
    platform ? `${platform}.clicks` : null,
    'buffer.engagement_rate',
    'buffer.clicks',
    'social.engagement_rate',
    'social.clicks',
  ].filter(Boolean) as string[];
}

export function chooseMeasurementMetric(taskOrId: string | TaskRow, opts: { metricOverride?: string | null } = {}): string | null {
  const task = typeof taskOrId === 'string' ? getTask(taskOrId) : taskOrId;
  if (!task) return null;
  if (opts.metricOverride) return opts.metricOverride;
  if (task.target_metric) return task.target_metric;
  if (task.action_type) {
    const override = DOMAIN_METRIC_OVERRIDES[task.action_type];
    if (override) return override;
  }
  if (task.action_type) {
    const entry = getActionRegistryEntry(task.action_type);
    const metric = entry?.success_metrics?.find((m) => typeof m === 'string' && m.trim());
    if (metric) return metric;
  }
  const memoryMetric = actionMemoryMetrics(task.id)[0];
  if (memoryMetric) return memoryMetric;
  if (isSocialTask(task)) return socialMetricCandidates(task).find((m) => latestMetric(task.business_id, m)) ?? socialMetricCandidates(task)[0] ?? null;
  return null;
}

function getCheckpoints(task: TaskRow, policy: MeasurementPolicyRow): number[] {
  if (task.action_type) {
    const entry = getActionRegistryEntry(task.action_type);
    const policyIsSpecific = Boolean(policy.business_id || policy.action_type || policy.metric_name);
    if (!policyIsSpecific && entry?.measurement_window_days?.length) return entry.measurement_window_days;
  }
  const policyDays = parseJson<number[]>(policy.checkpoints_json, []);
  if (policyDays.length) return Array.from(new Set(policyDays.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 0)));
  if (task.action_type) {
    const entry = getActionRegistryEntry(task.action_type);
    if (entry?.measurement_window_days?.length) return entry.measurement_window_days;
  }
  return [0, 7, 28, 90];
}

function isoAfterDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function expectedOutcome(task: TaskRow, metricName: string | null, input?: string | null): string | null {
  if (input) return input;
  if (task.expected_outcome) return task.expected_outcome;
  const payload = parseJson<Record<string, unknown>>(task.action_payload, {});
  const fromPayload = payload.expected_outcome ?? payload.expectedOutcome ?? payload.expected_result ?? payload.expectedResult;
  if (typeof fromPayload === 'string' && fromPayload.trim()) return fromPayload.trim();
  if (metricName) return `Improve or protect ${metricName} after ${task.action_type ?? 'task'} completes.`;
  return null;
}

function baselineSnapshot(metric: MetricRow | null, missingReason?: string): string {
  const snapshot = metric ? {
    metric_name: metric.metric_name,
    value: metric.metric_value,
    recorded_at: metric.recorded_at,
    period_start: metric.period_start,
    period_end: metric.period_end,
    source: `metrics:${metric.connector_id}`,
  } : {
    metric_name: null,
    value: null,
    recorded_at: null,
    source: 'metrics',
    missing_reason: missingReason ?? 'No matching metric row with a numeric value.',
  };
  return JSON.stringify(redact(snapshot));
}

export function prepareOutcomeMeasurement(taskId: string, opts: { metricOverride?: string | null; expectedOutcome?: string | null } = {}): {
  task_id: string;
  metric_name: string | null;
  baseline_value: number | null;
  expected_outcome: string | null;
  scheduled: number;
} {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const metricName = chooseMeasurementMetric(task, opts);
  const metric = metricName ? latestMetric(task.business_id, metricName) : null;
  const expected = expectedOutcome(task, metricName, opts.expectedOutcome);
  const policy = getPolicy(task.business_id, task.action_type, metricName);
  const snapshot = baselineSnapshot(metric, metricName ? undefined : 'No measurable target metric could be selected.');

  db.prepare(`
    UPDATE tasks
    SET target_metric = COALESCE(?, target_metric),
        target_metric_baseline = COALESCE(?, target_metric_baseline),
        expected_outcome = COALESCE(?, expected_outcome),
        external_baseline_snapshot = ?,
        measurement_policy_id = COALESCE(measurement_policy_id, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(metricName, metric?.metric_value ?? null, expected, snapshot, policy.id, taskId);

  emitActivityLedger('measurement.baseline_recorded', {
    task_id: taskId,
    business_id: task.business_id,
    metric_name: metricName,
    baseline_available: metric?.metric_value != null,
  });

  const scheduled = scheduleMeasurements(taskId);
  return {
    task_id: taskId,
    metric_name: metricName,
    baseline_value: metric?.metric_value ?? null,
    expected_outcome: expected,
    scheduled,
  };
}

export function scheduleMeasurements(taskId: string): number {
  const task = getTask(taskId);
  if (!task) return 0;
  const metricName = chooseMeasurementMetric(task);
  const policy = getPolicy(task.business_id, task.action_type, metricName);
  const checkpoints = getCheckpoints(task, policy);
  let inserted = 0;
  for (const day of checkpoints) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO outcome_measurement_runs
        (id, task_id, business_id, policy_id, checkpoint_at, checkpoint_day, baseline_value, state, evidence_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_measurement', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(generateId(), taskId, task.business_id, policy.id, isoAfterDays(Number(day)), Number(day), task.target_metric_baseline ?? null);
    inserted += result.changes ?? 0;
  }
  if (inserted > 0) {
    emitActivityLedger('measurement.scheduled', { task_id: taskId, business_id: task.business_id, checkpoints });
  }
  return inserted;
}

function isLowerBetter(metricName: string): boolean {
  return LOWER_IS_BETTER_PATTERNS.some((rx) => rx.test(metricName));
}

function compareMetric(metricName: string, baseline: number, observed: number, thresholdPct: number): { verdict: ServiceVerdict; changePct: number } {
  const rawPct = baseline !== 0 ? ((observed - baseline) / Math.abs(baseline)) * 100 : observed === baseline ? 0 : 100;
  const directionalPct = isLowerBetter(metricName) ? -rawPct : rawPct;
  const threshold = Math.max(0, thresholdPct);
  if (Math.abs(directionalPct) <= threshold) return { verdict: 'NEUTRAL', changePct: rawPct };
  return { verdict: directionalPct > 0 ? 'POSITIVE' : 'NEGATIVE', changePct: rawPct };
}

export function toDbRunState(verdict: ServiceVerdict): string {
  switch (verdict) {
    case 'POSITIVE': return 'successful';
    case 'NEGATIVE': return 'unsuccessful';
    case 'NEUTRAL': return 'neutral';
    case 'NOT_MEASURABLE': return 'blocked_by_missing_data';
    case 'INCONCLUSIVE':
    default: return 'inconclusive';
  }
}

export function toDbOutcomeVerdict(verdict: ServiceVerdict): string {
  switch (verdict) {
    case 'POSITIVE': return 'improved';
    case 'NEGATIVE': return 'worsened';
    case 'NEUTRAL': return 'no_change';
    case 'NOT_MEASURABLE': return 'blocked';
    case 'INCONCLUSIVE':
    default: return 'inconclusive';
  }
}

function confidenceFor(verdict: ServiceVerdict, baseline: number | null, observed: number | null, changePct: number | null, metric: MetricRow | null): number {
  if (verdict === 'NOT_MEASURABLE') return 0.1;
  if (verdict === 'INCONCLUSIVE') return 0.25;
  let confidence = 0.65;
  if (baseline != null && observed != null) confidence += 0.15;
  if (metric?.recorded_at) confidence += 0.1;
  if (changePct != null && Math.abs(changePct) >= 10) confidence += 0.1;
  return Math.min(0.95, Math.round(confidence * 100) / 100);
}

function diagnosticText(input: {
  verdict: ServiceVerdict;
  metricName: string | null;
  baseline: number | null;
  observed: number | null;
  changePct: number | null;
  expected: string | null;
  socialCharacteristics?: string[];
}): string {
  const safeMetric = input.metricName ?? 'unselected metric';
  if (input.verdict === 'NOT_MEASURABLE') return `No current authoritative metric data is available for ${safeMetric}; not marking the action negative.`;
  if (input.verdict === 'INCONCLUSIVE') return `Measurement for ${safeMetric} is inconclusive because the baseline or comparison evidence is incomplete.`;
  const pct = input.changePct == null ? 'unknown change' : `${input.changePct >= 0 ? '+' : ''}${input.changePct.toFixed(1)}%`;
  const extra = input.socialCharacteristics?.length ? ` Characteristics: ${input.socialCharacteristics.join(', ')}.` : '';
  return `${safeMetric}: ${input.baseline} -> ${input.observed} (${pct}). Expected: ${input.expected ?? 'not specified'}.${extra}`;
}

function upsertTaskOutcome(task: TaskRow, run: MeasurementRunRow, metricName: string, observed: number, baseline: number, changePct: number, verdict: ServiceVerdict, diagnostic: string): void {
  const weeksAfter = Math.max(0, Math.round(Number(run.checkpoint_day) / 7));
  const existing = db.prepare('SELECT id FROM task_outcomes WHERE task_id = ? AND weeks_after = ?').get(task.id, weeksAfter) as { id: string } | null;
  if (existing) return;
  db.prepare(`
    INSERT INTO task_outcomes (id, task_id, check_date, weeks_after, metric_value, baseline_value, change_pct, verdict, verdict_detail, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(generateId(), task.id, weeksAfter, observed, baseline, changePct, toDbOutcomeVerdict(verdict), diagnostic);
  if (task.status === 'complete') {
    db.prepare("UPDATE tasks SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'complete'").run(task.id);
  }
}

export function extractSocialCharacteristics(input: { caption?: string | null; mediaUrls?: unknown; mediaAltText?: string | null; metadata?: unknown }): string[] {
  const caption = String(input.caption ?? '').trim();
  const alt = String(input.mediaAltText ?? '').trim();
  const metadata = parseJson<Record<string, unknown>>(input.metadata, {});
  const combined = `${caption} ${alt} ${JSON.stringify(metadata)}`.toLowerCase();
  const mediaUrls = Array.isArray(input.mediaUrls) ? input.mediaUrls : parseJson<unknown[]>(input.mediaUrls, []);
  const out = new Set<string>();
  if (/customer|ugc|client/.test(combined) && mediaUrls.length) out.add('customer_photo');
  if (/review|testimonial|five star|5-star|rated/.test(combined)) out.add('review_quote');
  if (/product|listing|item|collection/.test(combined) && mediaUrls.length) out.add('product_image');
  if (caption.length > 0 && caption.length <= 120) out.add('short_caption');
  if (caption.length > 220) out.add('long_caption');
  if (/bright|colourful|colorful|vibrant/.test(combined)) out.add('bright_design');
  if (/minimal|clean|plain|simple/.test(combined)) out.add('minimal_design');
  return Array.from(out);
}

function socialCharacteristicsForTask(task: TaskRow): string[] {
  const payload = parseJson<Record<string, unknown>>(task.action_payload, {});
  const postId = payload.social_post_id ?? payload.post_id;
  const post = postId
    ? db.prepare('SELECT caption, media_urls, media_alt_text FROM social_posts WHERE id = ? AND business_id = ?').get(String(postId), task.business_id) as Record<string, unknown> | null
    : null;
  return extractSocialCharacteristics({
    caption: String(post?.caption ?? payload.caption ?? ''),
    mediaUrls: post?.media_urls ?? payload.media_urls ?? payload.mediaUrls ?? [],
    mediaAltText: String(post?.media_alt_text ?? payload.media_alt_text ?? ''),
    metadata: payload.media_metadata ?? payload.metadata ?? {},
  });
}

function updateActionMemory(task: TaskRow, summary: string, measured: boolean): void {
  const row = db.prepare('SELECT id FROM action_memory WHERE task_id = ? LIMIT 1').get(task.id) as { id: string } | null;
  if (row) {
    db.prepare('UPDATE action_memory SET outcome_measured = ?, outcome_summary = ?, measurement_ready = 1 WHERE id = ?').run(measured ? 1 : 0, summary, row.id);
    return;
  }
  if (!task.action_type) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO action_memory
      (id, business_id, task_id, action_type, title, description, metrics_expected, measurement_window_start, measurement_window_end, do_not_touch_until, measurement_ready, outcome_measured, outcome_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(generateId(), task.business_id, task.id, task.action_type, task.title, task.description, JSON.stringify(task.target_metric ? [task.target_metric] : []), task.completed_at ?? now, now, now, measured ? 1 : 0, summary);
}

function recordLesson(task: TaskRow, completion: MeasurementCompletion): void {
  const verdict = completion.service_verdict;
  if (verdict === 'INCONCLUSIVE') return;
  const metric = completion.metric_name ?? 'selected metric';
  const summary = verdict === 'NOT_MEASURABLE'
    ? `No reusable commercial lesson yet: ${metric} could not be measured from current connector data. Keep future ${task.action_type ?? 'actions'} tied to an available metric before judging outcome.`
    : `${task.action_type ?? 'Action'} on "${task.title}" was ${verdict.toLowerCase()} for ${metric}: ${completion.baseline_value} -> ${completion.observed_value}${completion.change_pct == null ? '' : ` (${completion.change_pct >= 0 ? '+' : ''}${completion.change_pct.toFixed(1)}%)`}.`;
  updateActionMemory(task, summary, true);
  emitActivityLedger('learning.lesson_recorded', {
    task_id: task.id,
    business_id: task.business_id,
    verdict,
    metric_name: completion.metric_name,
  });
}

export function completeMeasurementRun(runId: string): MeasurementCompletion | null {
  const run = db.prepare('SELECT * FROM outcome_measurement_runs WHERE id = ?').get(runId) as MeasurementRunRow | null;
  if (!run) return null;
  const task = getTask(run.task_id);
  if (!task) return null;
  const metricName = chooseMeasurementMetric(task);
  const baseline = run.baseline_value ?? task.target_metric_baseline;
  const metric = metricName ? latestMetric(task.business_id, metricName) : null;
  const policy = getPolicy(task.business_id, task.action_type, metricName);
  const threshold = Number(policy.minimum_meaningful_change ?? getActionRegistryEntry(task.action_type ?? '')?.acceptable_variance ?? 0);
  const thresholdPct = threshold <= 1 ? threshold * 100 : threshold;
  const socialCharacteristics = isSocialTask(task) ? socialCharacteristicsForTask(task) : [];

  let verdict: ServiceVerdict;
  let changePct: number | null = null;
  if (!metricName || !metric || metric.metric_value == null) {
    verdict = 'NOT_MEASURABLE';
  } else if (baseline == null) {
    verdict = 'INCONCLUSIVE';
  } else {
    const comparison = compareMetric(metricName, Number(baseline), Number(metric.metric_value), thresholdPct);
    verdict = comparison.verdict;
    changePct = comparison.changePct;
  }

  const evidenceStatus: EvidenceStatus =
    verdict === 'NOT_MEASURABLE' ? 'blocked' :
    verdict === 'INCONCLUSIVE' ? 'unknown' :
    metric?.recorded_at ? 'observed' : 'inferred';
  const diagnostic = diagnosticText({
    verdict,
    metricName,
    baseline: baseline ?? null,
    observed: metric?.metric_value ?? null,
    changePct,
    expected: task.expected_outcome,
    socialCharacteristics,
  });
  const completion: MeasurementCompletion = {
    run_id: run.id,
    task_id: task.id,
    service_verdict: verdict,
    db_verdict: toDbOutcomeVerdict(verdict),
    state: toDbRunState(verdict),
    evidence_status: evidenceStatus,
    confidence: confidenceFor(verdict, baseline ?? null, metric?.metric_value ?? null, changePct, metric),
    quiet_notification: true,
    diagnostic,
    metric_name: metricName,
    baseline_value: baseline ?? null,
    observed_value: metric?.metric_value ?? null,
    change_pct: changePct,
  };

  db.prepare(`
    UPDATE outcome_measurement_runs
    SET observed_value = ?, verdict = ?, state = ?, evidence_status = ?, diagnostic = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(completion.observed_value, completion.db_verdict, completion.state, completion.evidence_status, diagnostic, run.id);

  if (['POSITIVE', 'NEGATIVE', 'NEUTRAL'].includes(verdict) && metricName && baseline != null && metric?.metric_value != null) {
    upsertTaskOutcome(task, run, metricName, Number(metric.metric_value), Number(baseline), changePct ?? 0, verdict, diagnostic);
  }

  recordLesson(task, completion);
  emitActivityLedger(verdict === 'INCONCLUSIVE' || verdict === 'NOT_MEASURABLE' ? 'measurement.inconclusive' : 'measurement.completed', {
    task_id: task.id,
    business_id: task.business_id,
    run_id: run.id,
    verdict,
    quiet_notification: true,
    confidence: completion.confidence,
  });
  return completion;
}

export function evaluateDueMeasurements(): { evaluated: number; changed: number; results: MeasurementCompletion[] } {
  const rows = db.prepare(`
    SELECT * FROM outcome_measurement_runs
    WHERE state IN ('pending_measurement','measuring')
      AND checkpoint_at <= CURRENT_TIMESTAMP
    ORDER BY checkpoint_at ASC
  `).all() as MeasurementRunRow[];
  const results: MeasurementCompletion[] = [];
  for (const row of rows) {
    const result = completeMeasurementRun(row.id);
    if (result) results.push(result);
  }
  return { evaluated: rows.length, changed: results.length, results };
}

export function inspectMeasurements(limit = 50): Record<string, unknown> {
  const base = `
    SELECT omr.id, omr.task_id, omr.business_id, omr.checkpoint_at, omr.checkpoint_day,
           omr.state, omr.verdict, omr.evidence_status, omr.diagnostic,
           t.title, t.action_type, t.target_metric, t.expected_outcome
    FROM outcome_measurement_runs omr
    LEFT JOIN tasks t ON t.id = omr.task_id
  `;
  return {
    due: db.prepare(`${base} WHERE omr.state IN ('pending_measurement','measuring') AND omr.checkpoint_at <= CURRENT_TIMESTAMP ORDER BY omr.checkpoint_at ASC LIMIT ?`).all(limit),
    overdue: db.prepare(`${base} WHERE omr.state IN ('pending_measurement','measuring') AND omr.checkpoint_at < datetime('now','-1 day') ORDER BY omr.checkpoint_at ASC LIMIT ?`).all(limit),
    completed: db.prepare(`${base} WHERE omr.state IN ('successful','unsuccessful','neutral') ORDER BY omr.updated_at DESC LIMIT ?`).all(limit),
    inconclusive_or_blocked: db.prepare(`${base} WHERE omr.state IN ('inconclusive','blocked_by_missing_data') ORDER BY omr.updated_at DESC LIMIT ?`).all(limit),
  };
}

function emitActivityLedger(eventName: string, payload: Record<string, unknown>): void {
  if (process.env.DATABASE_PATH === ':memory:' || process.env.NODE_ENV === 'test') return;
  try {
    const clean = redact(payload) as Record<string, unknown>;
    const body = JSON.stringify({ eventName, payload: clean });
    const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, '/home/chris/.hermes/activity')
from activity_ledger import safe_record_event
body = json.loads(sys.argv[1])
event = body['eventName']
payload = body.get('payload') or {}
safe_record_event(
    event_type=event,
    source='blueprint_measurement_learning',
    action=event.split('.')[-1],
    status='blocked' if 'inconclusive' in event else 'completed',
    summary=str(payload.get('diagnostic') or f"{event} for task {payload.get('task_id', 'unknown')}")[:500],
    workflow='blueprint_outcome_learning',
    entity_type='blueprint_task',
    entity_id=str(payload.get('task_id') or ''),
    metadata=payload,
    idempotency_key=f"blueprint:{event}:{payload.get('run_id') or payload.get('task_id') or ''}",
)
`;
    const child = spawn('/usr/bin/env', ['python3', '-c', code, body], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Hermes profile helpers are optional for Blueprint; measurement must not depend on them.
  }
}
