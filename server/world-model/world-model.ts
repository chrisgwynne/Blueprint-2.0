/**
 * Business World Model.
 *
 * A continuously updated, timestamped snapshot of "what Blueprint
 * currently believes" about a business — assembled from existing
 * subsystems (goals, signals, investigations, conflicts, connector
 * confidence, agent calibration, task outcomes) rather than a new
 * statistics engine. The intent (per the spec): agents should reason from
 * the World Model, not directly from connector outputs — connectors
 * update the World Model, signals/recommendations/tasks derive from it.
 *
 * Scoping note: revenue/traffic/seo/lead_gen/marketing "trend" fields are
 * a coarse bucketing of the business's most recent open signals by
 * keyword, not a full metrics regression — a documented simplification,
 * not a claim of statistical rigor. Wiring every one of rules.ts's ~40
 * signal-evaluation functions to consume World Model state instead of raw
 * connector data is out of scope for this phase (see PHASE2-INT.md).
 */
import db, { generateId } from '../db/db.js';
import { listConnectorConfidence, isLowConfidence } from '../connectors/confidence.js';

export type TrendDirection = 'improving' | 'declining' | 'stable' | 'unknown';

export interface TrendSummary {
  direction: TrendDirection;
  open_signal_count: number;
  detail?: string;
}

export interface WorldModelSnapshot {
  business_health: { status: TrendDirection; open_critical_signals: number };
  revenue_trend: TrendSummary;
  traffic_trend: TrendSummary;
  seo_trend: TrendSummary;
  lead_gen_trend: TrendSummary;
  marketing_trend: TrendSummary;
  development_activity: { open_signals: number };
  operational_health: { open_signals: number; critical_signals: number };
  open_risks: Array<{ id: string; title: string; severity: string; type: string }>;
  open_opportunities: Array<{ id: string; title: string }>;
  connector_confidence: { avg_overall_confidence: number | null; low_confidence_count: number; total: number };
  knowledge_confidence: { avg_calibration_score: number | null; sample_size: number };
  goal_progress: Array<{ goal_id: string; title: string; progress_pct: number; status: string }>;
  outstanding_investigations: number;
  active_experiments: number;
  recent_outcomes: Array<{ task_id: string; verdict: string | null; change_pct: number | null }>;
  prediction_confidence: number | null;
  agent_confidence: Array<{ agent_id: string; calibration_score: number | null }>;
  /**
   * Full-enforcement follow-up: "connectors update the World Model, signals
   * are generated from the World Model" — the raw per-connector data blob
   * (same shape signal-engine.ts's rules already evaluate), keyed by
   * connector_id. server/jobs/scheduler.ts and server/routes/connectors.ts
   * now source runSignalEngine()'s `previousData` from the World Model's
   * prior snapshot instead of an ad-hoc `metrics` table diff — the 40
   * existing signal rules never had to change, only where their input
   * comes from.
   */
  connector_data: Record<string, { connector_id: string; connector_type: string; data: unknown; recorded_at: string }>;
}

const TREND_KEYWORDS: Record<string, RegExp> = {
  revenue: /revenue|sales|order|checkout|conversion|aov/i,
  traffic: /traffic|session|pageview|visitor|bounce/i,
  seo: /seo|ranking|serp|impression|ctr|search.?console|backlink/i,
  lead_gen: /lead|form.?submission|enquiry|inquiry/i,
  marketing: /campaign|ad.?spend|roas|email.?open|ads?\b/i,
};

function bucketSignalTrend(signals: Array<{ type: string; title: string; severity: string }>, pattern: RegExp): TrendSummary {
  const matched = signals.filter((s) => pattern.test(s.type) || pattern.test(s.title));
  if (matched.length === 0) return { direction: 'unknown', open_signal_count: 0 };
  const criticalCount = matched.filter((s) => s.severity === 'critical').length;
  const direction: TrendDirection = criticalCount > 0 ? 'declining' : matched.length > 2 ? 'declining' : 'stable';
  return { direction, open_signal_count: matched.length };
}

function safeQuery<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function buildWorldModelSnapshot(businessId: string): WorldModelSnapshot {
  const openSignals = safeQuery(
    () => db.prepare(`SELECT id, type, title, severity FROM signals WHERE business_id = ? AND status = 'open'`).all(businessId) as Array<{ id: string; type: string; title: string; severity: string }>,
    [] as Array<{ id: string; type: string; title: string; severity: string }>,
  );
  const criticalSignals = openSignals.filter((s) => s.severity === 'critical');

  const goalRows = safeQuery(
    () => db.prepare(`SELECT id, title, progress_pct, status FROM goals WHERE business_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 20`).all(businessId) as Array<{ id: string; title: string; progress_pct: number; status: string }>,
    [] as Array<{ id: string; title: string; progress_pct: number; status: string }>,
  );

  const investigationCount = safeQuery(
    () => (db.prepare(`SELECT COUNT(*) as n FROM investigations WHERE business_id = ? AND created_at > datetime('now', '-30 days')`).get(businessId) as { n: number }).n,
    0,
  );

  const experimentCount = safeQuery(
    () => (db.prepare(`SELECT COUNT(*) as n FROM scenarios WHERE business_id = ? AND created_at > datetime('now', '-30 days')`).get(businessId) as { n: number }).n,
    0,
  );

  const openConflicts = safeQuery(
    () => db.prepare(`SELECT id, description as title, severity, conflict_type as type FROM conflicts WHERE business_id = ? AND status = 'open'`).all(businessId) as Array<{ id: string; title: string; severity: string; type: string }>,
    [] as Array<{ id: string; title: string; severity: string; type: string }>,
  );

  const openOpportunities = safeQuery(
    () => db.prepare(`SELECT id, title FROM goal_suggestions WHERE business_id = ? AND status = 'pending' LIMIT 20`).all(businessId) as Array<{ id: string; title: string }>,
    [] as Array<{ id: string; title: string }>,
  );

  const recentOutcomes = safeQuery(
    () => db.prepare(`
      SELECT task_id, verdict, change_pct FROM task_outcomes
      WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)
      ORDER BY created_at DESC LIMIT 20
    `).all(businessId) as Array<{ task_id: string; verdict: string | null; change_pct: number | null }>,
    [] as Array<{ task_id: string; verdict: string | null; change_pct: number | null }>,
  );

  const calibrationRows = safeQuery(
    () => db.prepare(`
      SELECT agent_id, calibration_score FROM agent_calibration
      WHERE business_id = ? AND period_end = (SELECT MAX(period_end) FROM agent_calibration WHERE business_id = ?)
    `).all(businessId, businessId) as Array<{ agent_id: string; calibration_score: number | null }>,
    [] as Array<{ agent_id: string; calibration_score: number | null }>,
  );
  const validCalibrationScores = calibrationRows.map((r) => r.calibration_score).filter((v): v is number => typeof v === 'number');
  const avgCalibration = validCalibrationScores.length > 0
    ? Math.round((validCalibrationScores.reduce((a, b) => a + b, 0) / validCalibrationScores.length) * 100) / 100
    : null;

  const confidences = listConnectorConfidence(businessId);
  const avgOverallConfidence = confidences.length > 0
    ? Math.round((confidences.reduce((a, c) => a + c.overall_confidence, 0) / confidences.length) * 100) / 100
    : null;
  const lowConfidenceCount = confidences.filter((c) => isLowConfidence(c)).length;

  const overallBusinessStatus: TrendDirection =
    criticalSignals.length > 0 ? 'declining' :
    openSignals.length === 0 ? 'stable' :
    openSignals.length > 5 ? 'declining' : 'stable';

  const connectorData: WorldModelSnapshot['connector_data'] = {};
  const connectorRows = safeQuery(
    () => db.prepare('SELECT id, type FROM connectors WHERE business_id = ?').all(businessId) as Array<{ id: string; type: string }>,
    [] as Array<{ id: string; type: string }>,
  );
  for (const c of connectorRows) {
    // recorded_at has only second-level precision — rowid DESC tiebreaks
    // ties so the truly most recent sync's blob wins (see getCurrentWorldModel's
    // identical fix below for the same underlying issue).
    const latest = safeQuery(
      () => db.prepare(`
        SELECT metric_data, recorded_at FROM metrics
        WHERE connector_id = ? AND metric_name = ?
        ORDER BY recorded_at DESC, rowid DESC LIMIT 1
      `).get(c.id, `${c.type}_sync`) as { metric_data: string | null; recorded_at: string } | undefined,
      undefined as { metric_data: string | null; recorded_at: string } | undefined,
    );
    if (!latest?.metric_data) continue;
    try {
      connectorData[c.id] = { connector_id: c.id, connector_type: c.type, data: JSON.parse(latest.metric_data), recorded_at: latest.recorded_at };
    } catch {
      // malformed blob — skip rather than poison the snapshot
    }
  }

  return {
    business_health: { status: overallBusinessStatus, open_critical_signals: criticalSignals.length },
    revenue_trend: bucketSignalTrend(openSignals, TREND_KEYWORDS.revenue!),
    traffic_trend: bucketSignalTrend(openSignals, TREND_KEYWORDS.traffic!),
    seo_trend: bucketSignalTrend(openSignals, TREND_KEYWORDS.seo!),
    lead_gen_trend: bucketSignalTrend(openSignals, TREND_KEYWORDS.lead_gen!),
    marketing_trend: bucketSignalTrend(openSignals, TREND_KEYWORDS.marketing!),
    development_activity: { open_signals: openSignals.filter((s) => /github|deploy|build|ci\b/i.test(s.type)).length },
    operational_health: { open_signals: openSignals.length, critical_signals: criticalSignals.length },
    open_risks: openConflicts.map((c) => ({ id: c.id, title: c.title, severity: c.severity, type: c.type })),
    open_opportunities: openOpportunities,
    connector_confidence: { avg_overall_confidence: avgOverallConfidence, low_confidence_count: lowConfidenceCount, total: confidences.length },
    knowledge_confidence: { avg_calibration_score: avgCalibration, sample_size: validCalibrationScores.length },
    goal_progress: goalRows.map((g) => ({ goal_id: g.id, title: g.title, progress_pct: g.progress_pct, status: g.status })),
    outstanding_investigations: investigationCount,
    active_experiments: experimentCount,
    recent_outcomes: recentOutcomes,
    prediction_confidence: avgCalibration,
    agent_confidence: calibrationRows,
    connector_data: connectorData,
  };
}

/**
 * The World Model's own record of a connector's most-recently-synced raw
 * data, as of the last snapshot written *before* this call — i.e. "what
 * we knew before this sync", the same role the old ad-hoc "previous row
 * in the metrics table" query used to play for signal-engine.ts. Reads
 * the CURRENT (about-to-be-superseded) snapshot, so callers must call this
 * before writing a new one.
 */
export function getPreviousConnectorData(businessId: string, connectorId: string): unknown {
  const current = getCurrentWorldModel(businessId);
  return current?.snapshot.connector_data?.[connectorId]?.data ?? null;
}

/** Persist a new timestamped, attributable snapshot. Fire-and-forget safe. */
export function writeWorldModelSnapshot(businessId: string, triggerSource: string): void {
  try {
    const snapshot = buildWorldModelSnapshot(businessId);
    db.prepare(`
      INSERT INTO world_model_snapshots (id, business_id, snapshot, trigger_source, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(generateId(), businessId, JSON.stringify(snapshot), triggerSource);
  } catch (err) {
    console.warn(`[world-model] snapshot write failed for business ${businessId}:`, (err as Error).message);
  }
}

export interface WorldModelSnapshotRow {
  id: string;
  business_id: string;
  snapshot: WorldModelSnapshot;
  trigger_source: string | null;
  created_at: string;
}

function parseRow(row: Record<string, unknown>): WorldModelSnapshotRow {
  return { ...row, snapshot: JSON.parse(row['snapshot'] as string) } as unknown as WorldModelSnapshotRow;
}

// created_at has only second-level precision, so ties are possible when
// multiple snapshots are written within the same second (e.g. several
// connectors syncing back-to-back). rowid increases with insertion order,
// so it's used as a tiebreaker to guarantee the truly most recent row wins.
export function getCurrentWorldModel(businessId: string): WorldModelSnapshotRow | null {
  const row = db.prepare('SELECT * FROM world_model_snapshots WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(businessId) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export function getWorldModelHistory(businessId: string, limit = 20): WorldModelSnapshotRow[] {
  const rows = db.prepare('SELECT * FROM world_model_snapshots WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(businessId, Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
  return rows.map(parseRow);
}
