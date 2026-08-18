import { beforeEach, describe, expect, test } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  completeMeasurementRun,
  evaluateDueMeasurements,
  extractSocialCharacteristics,
  prepareOutcomeMeasurement,
  scheduleMeasurements,
  toDbOutcomeVerdict,
} from './measurement-learning.js';

const BIZ = 'biz_measurement_learning';

function cleanup(): void {
  db.prepare(`DELETE FROM task_outcomes WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)`).run(BIZ);
  db.prepare(`DELETE FROM outcome_measurement_runs WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM action_memory WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM social_posts WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM metrics WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM connectors WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM tasks WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM measurement_policies WHERE business_id = ?`).run(BIZ);
  db.prepare(`DELETE FROM businesses WHERE id = ?`).run(BIZ);
}

function insertConnector(id = 'conn_gsc', type = 'gsc'): string {
  db.prepare(`INSERT INTO connectors (id, business_id, type, name, status, last_sync) VALUES (?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)`)
    .run(id, BIZ, type, type.toUpperCase());
  return id;
}

function insertMetric(metricName: string, value: number, connectorId = 'conn_gsc', recorded = 'CURRENT_TIMESTAMP'): void {
  db.prepare(`
    INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ${recorded})
  `).run(generateId(), BIZ, connectorId, metricName, value, JSON.stringify({ note: 'safe', api_key: 'should-not-appear-in-snapshot' }));
}

function insertPolicy(actionType: string, threshold = 5): void {
  db.prepare(`
    INSERT INTO measurement_policies
      (id, business_id, action_type, name, checkpoints_json, final_day, minimum_meaningful_change, active)
    VALUES (?, ?, ?, 'Test policy', '[0,7]', 7, ?, 1)
  `).run(`policy_${actionType}`, BIZ, actionType, threshold);
}

function insertTask(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks
      (id, business_id, title, description, proposed_by, status, trust_tier, approval_mode,
       action_type, action_payload, confidence, target_metric, target_metric_baseline,
       expected_outcome, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'agent:test', ?, 'yellow', 'requires_approval',
      ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    id,
    BIZ,
    (overrides.title as string) ?? 'Fixture measurement task',
    (overrides.description as string | null) ?? null,
    (overrides.status as string) ?? 'complete',
    (overrides.action_type as string) ?? 'meta_update',
    JSON.stringify((overrides.action_payload as Record<string, unknown>) ?? {}),
    'confidence' in overrides ? (overrides.confidence as number | null) : 0.8,
    'target_metric' in overrides ? (overrides.target_metric as string | null) : null,
    'target_metric_baseline' in overrides ? (overrides.target_metric_baseline as number | null) : null,
    (overrides.expected_outcome as string | null) ?? null,
  );
  return id;
}

function dueRun(taskId: string): string {
  db.prepare(`UPDATE outcome_measurement_runs SET checkpoint_at = datetime('now','-1 minute') WHERE task_id = ?`).run(taskId);
  const row = db.prepare(`SELECT id FROM outcome_measurement_runs WHERE task_id = ? ORDER BY checkpoint_day ASC LIMIT 1`).get(taskId) as { id: string };
  return row.id;
}

beforeEach(() => {
  cleanup();
  db.prepare(`INSERT INTO businesses (id, name, slug, type) VALUES (?, 'Measurement Learning', 'measurement-learning', 'ecommerce')`).run(BIZ);
});

describe('measurement learning adoption loop', () => {
  test('captures baseline, expected outcome, sanitised snapshot and schedules idempotently', () => {
    insertConnector();
    insertMetric('gsc.avg_ctr', 2.5);
    insertPolicy('meta_update');
    const taskId = insertTask({ action_type: 'meta_update', expected_outcome: null });

    const prepared = prepareOutcomeMeasurement(taskId, { expectedOutcome: 'CTR should improve after the metadata change.' });
    const task = db.prepare(`SELECT target_metric, target_metric_baseline, expected_outcome, external_baseline_snapshot FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;

    expect(prepared.metric_name).toBe('gsc.avg_ctr');
    expect(prepared.baseline_value).toBe(2.5);
    expect(task.target_metric_baseline).toBe(2.5);
    expect(task.expected_outcome).toBe('CTR should improve after the metadata change.');
    expect(String(task.external_baseline_snapshot)).toContain('gsc.avg_ctr');
    expect(String(task.external_baseline_snapshot)).not.toContain('should-not-appear');
    expect(prepared.scheduled).toBe(2);
    expect(scheduleMeasurements(taskId)).toBe(0);
  });

  test('records POSITIVE SEO comparison and writes task_outcomes plus action_memory lesson', () => {
    insertConnector();
    insertMetric('gsc.avg_ctr', 2.0);
    insertPolicy('meta_update', 5);
    const taskId = insertTask({ action_type: 'meta_update' });
    prepareOutcomeMeasurement(taskId);
    insertMetric('gsc.avg_ctr', 2.4);
    const result = completeMeasurementRun(dueRun(taskId));

    expect(result?.service_verdict).toBe('POSITIVE');
    expect(result?.db_verdict).toBe('improved');
    expect(result?.state).toBe('successful');
    expect(result?.evidence_status).toBe('observed');
    expect(result?.confidence).toBeGreaterThan(0.7);
    expect(result?.quiet_notification).toBe(true);

    const outcome = db.prepare(`SELECT verdict, change_pct FROM task_outcomes WHERE task_id = ?`).get(taskId) as Record<string, unknown>;
    expect(outcome.verdict).toBe('improved');
    expect(Number(outcome.change_pct)).toBeGreaterThan(19);
    const memory = db.prepare(`SELECT outcome_measured, outcome_summary FROM action_memory WHERE task_id = ?`).get(taskId) as Record<string, unknown>;
    expect(memory.outcome_measured).toBe(1);
    expect(String(memory.outcome_summary)).toContain('positive');
  });

  test('records NEGATIVE and NEUTRAL verdicts without duplicate task_outcomes', () => {
    insertConnector();
    insertPolicy('content_draft', 5);

    insertMetric('gsc.total_clicks', 100);
    const negativeTask = insertTask({ action_type: 'content_draft' });
    prepareOutcomeMeasurement(negativeTask);
    insertMetric('gsc.total_clicks', 80);
    const negativeRun = dueRun(negativeTask);
    expect(completeMeasurementRun(negativeRun)?.service_verdict).toBe('NEGATIVE');
    completeMeasurementRun(negativeRun);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM task_outcomes WHERE task_id = ?`).get(negativeTask) as { c: number }).c).toBe(1);

    insertMetric('gsc.total_clicks', 100);
    const neutralTask = insertTask({ action_type: 'content_draft' });
    prepareOutcomeMeasurement(neutralTask);
    insertMetric('gsc.total_clicks', 103);
    expect(completeMeasurementRun(dueRun(neutralTask))?.service_verdict).toBe('NEUTRAL');
    expect((db.prepare(`SELECT verdict FROM task_outcomes WHERE task_id = ?`).get(neutralTask) as { verdict: string }).verdict).toBe('no_change');
  });

  test('uses lower-is-better direction for SEO average position', () => {
    insertConnector();
    insertPolicy('seo_position_test', 5);
    insertMetric('gsc.avg_position', 20);
    const taskId = insertTask({ action_type: 'seo_position_test', target_metric: 'gsc.avg_position' });
    prepareOutcomeMeasurement(taskId);
    insertMetric('gsc.avg_position', 15);
    expect(completeMeasurementRun(dueRun(taskId))?.service_verdict).toBe('POSITIVE');
  });

  test('missing baseline is INCONCLUSIVE when current provider data exists', () => {
    insertConnector();
    insertPolicy('meta_update');
    const taskId = insertTask({ action_type: 'meta_update', target_metric: 'gsc.avg_ctr' });
    scheduleMeasurements(taskId);
    insertMetric('gsc.avg_ctr', 2.8);
    const result = completeMeasurementRun(dueRun(taskId));

    expect(result?.service_verdict).toBe('INCONCLUSIVE');
    expect(result?.state).toBe('inconclusive');
    expect(result?.evidence_status).toBe('unknown');
    expect((db.prepare(`SELECT COUNT(*) AS c FROM task_outcomes WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(0);
  });

  test('missing provider data and empty social metrics are NOT_MEASURABLE, never negative', () => {
    insertConnector('conn_buffer', 'buffer');
    insertPolicy('social_post');
    const postId = generateId();
    db.prepare(`
      INSERT INTO social_posts (id, business_id, connector_id, platform, target_id, content_type, caption, media_urls, media_alt_text, status)
      VALUES (?, ?, 'conn_buffer', 'instagram', 'profile-1', 'image', ?, ?, 'Bright customer photo with five star review', 'published')
    `).run(postId, BIZ, 'Five star customer review for our product', JSON.stringify(['https://example.test/photo.jpg']));
    const taskId = insertTask({
      action_type: 'social_post',
      title: 'Publish social post',
      action_payload: { social_post_id: postId, platform: 'instagram' },
    });

    prepareOutcomeMeasurement(taskId);
    const result = completeMeasurementRun(dueRun(taskId));

    expect(result?.service_verdict).toBe('NOT_MEASURABLE');
    expect(result?.state).toBe('blocked_by_missing_data');
    expect(result?.db_verdict).toBe('blocked');
    expect(result?.diagnostic).toContain('not marking the action negative');
    const memory = db.prepare(`SELECT outcome_measured, outcome_summary FROM action_memory WHERE task_id = ?`).get(taskId) as Record<string, unknown>;
    expect(memory.outcome_measured).toBe(1);
    expect(String(memory.outcome_summary)).toContain('No reusable commercial lesson yet');
  });

  test('extracts social characteristics only from caption/media metadata', () => {
    expect(extractSocialCharacteristics({
      caption: 'Five star review from a customer',
      mediaUrls: ['https://example.test/a.jpg'],
      mediaAltText: 'Bright product image',
      metadata: { style: 'minimal' },
    }).sort()).toEqual(['bright_design', 'customer_photo', 'minimal_design', 'product_image', 'review_quote', 'short_caption'].sort());
  });

  test('evaluateDueMeasurements returns quiet metadata and Activity Ledger fails soft', () => {
    insertConnector();
    insertMetric('gsc.avg_ctr', 2.0);
    insertPolicy('meta_update', 5);
    const taskId = insertTask({ action_type: 'meta_update' });
    prepareOutcomeMeasurement(taskId);
    insertMetric('gsc.avg_ctr', 2.3);
    dueRun(taskId);

    const result = evaluateDueMeasurements();
    expect(result.evaluated).toBeGreaterThan(0);
    expect(result.results[0]?.quiet_notification).toBe(true);
  });

  test('service vocabulary maps to existing DB vocabulary', () => {
    expect(toDbOutcomeVerdict('POSITIVE')).toBe('improved');
    expect(toDbOutcomeVerdict('NEGATIVE')).toBe('worsened');
    expect(toDbOutcomeVerdict('NEUTRAL')).toBe('no_change');
    expect(toDbOutcomeVerdict('INCONCLUSIVE')).toBe('inconclusive');
    expect(toDbOutcomeVerdict('NOT_MEASURABLE')).toBe('blocked');
  });
});
