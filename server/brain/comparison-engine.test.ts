/**
 * Recommendation comparison mode (#66).
 *
 * Covers the acceptance criteria the feature actually promises:
 *   - comparable candidates within one explicit business scope,
 *   - a cross-business comparison attempt is REJECTED, not silently mixed,
 *   - unknown / incomparable fields are marked, never fabricated,
 *   - shared vs differing dimensions are computed correctly,
 *   - a selection writes a real decision with rationale + policy version,
 *   - a deferral does the same without picking a winner,
 *   - and entering / building a comparison performs NO execution or
 *     approval side effects whatsoever.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import {
  buildComparison, recordComparisonDecision, listComparableCandidates,
  ComparisonRejectedError, MAX_COMPARISON_CANDIDATES,
} from './comparison-engine.js';
import { savePolicyVersion } from '../policy/operating-policy.js';

const BIZ_A = 'biz_cmp_a';
const BIZ_B = 'biz_cmp_b';
const ACTOR = 'dashboard:cmp-operator';

function insertTask(overrides: Record<string, unknown> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  db.prepare(`
    INSERT INTO tasks (
      id, business_id, title, description, proposed_by, status, trust_tier, approval_mode,
      action_type, action_payload, confidence, priority, estimated_impact, target_metric,
      signal_id, goal_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'yellow', 'requires_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    (overrides.business_id as string) ?? BIZ_A,
    (overrides.title as string) ?? 'Fixture comparison task',
    (overrides.description as string) ?? null,
    (overrides.proposed_by as string) ?? 'agent:cmp',
    (overrides.status as string) ?? 'proposed',
    'action_type' in overrides ? (overrides.action_type as string | null) : 'content_draft',
    JSON.stringify(overrides.action_payload ?? {}),
    'confidence' in overrides ? (overrides.confidence as number | null) : 0.8,
    (overrides.priority as string) ?? 'p2',
    'estimated_impact' in overrides ? (overrides.estimated_impact as string | null) : null,
    'target_metric' in overrides ? (overrides.target_metric as string | null) : null,
    (overrides.signal_id as string | null) ?? null,
    (overrides.goal_id as string | null) ?? null,
    (overrides.created_at as string) ?? new Date().toISOString(),
  );
  return id;
}

function insertStrategy(overrides: Record<string, unknown> = {}): string {
  const id = (overrides.id as string) ?? generateId();
  const goalId = (overrides.goal_id as string) ?? 'goal_cmp_a';
  db.prepare(`
    INSERT INTO goal_strategies (
      id, goal_id, business_id, name, summary, expected_impact_summary, confidence,
      estimated_effort, estimated_cost, estimated_cost_unit, time_to_impact_days, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'gbp', ?, 'candidate', CURRENT_TIMESTAMP)
  `).run(
    id, goalId, (overrides.business_id as string) ?? BIZ_A,
    (overrides.name as string) ?? 'Fixture strategy',
    (overrides.summary as string) ?? null,
    'expected_impact_summary' in overrides ? (overrides.expected_impact_summary as string | null) : '+10% conversion',
    'confidence' in overrides ? (overrides.confidence as number | null) : 0.6,
    'estimated_effort' in overrides ? (overrides.estimated_effort as string | null) : 'medium',
    'estimated_cost' in overrides ? (overrides.estimated_cost as number | null) : 250,
    'time_to_impact_days' in overrides ? (overrides.time_to_impact_days as number | null) : 30,
  );
  return id;
}

/**
 * Row counts are scoped to this file's fixture businesses. A global count
 * would be polluted by every other suite sharing the in-memory database,
 * which would make "comparison wrote nothing" pass or fail by accident.
 */
function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id IN (?, ?)`).get(BIZ_A, BIZ_B) as { n: number }).n;
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Cmp A', 'cmp-a') ON CONFLICT(id) DO NOTHING").run(BIZ_A);
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Cmp B', 'cmp-b') ON CONFLICT(id) DO NOTHING").run(BIZ_B);
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, priority, created_at, updated_at)
    VALUES ('goal_cmp_a', ?, 'Grow revenue', 'active', 'p1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `).run(BIZ_A);
});

beforeEach(() => {
  const ids = [BIZ_A, BIZ_B];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM goal_strategies WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM goal_suggestions WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM decisions WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM conflicts WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policy_events WHERE scope_key IN (${ph})`).run(...ids);
  db.prepare('DELETE FROM execution_jobs').run();
});

afterAll(() => {
  const ids = [BIZ_A, BIZ_B];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM goal_strategies WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM decisions WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph})`).run(...ids);
});

// ─── Comparable candidates within one business ──────────────────────────────

describe('buildComparison — comparable candidates in one business scope', () => {
  test('normalises two same-class tasks into one comparable shape', () => {
    const a = insertTask({ title: 'Rewrite product copy', confidence: 0.9 });
    const b = insertTask({ title: 'Rewrite category copy', confidence: 0.5 });

    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);

    expect(result.business_id).toBe(BIZ_A);
    expect(result.read_only).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(result.comparability.decision_classes).toEqual(['task:internal_idempotent']);
    // Both are the same decision class, so no mixed-class warning.
    expect(result.comparability.warnings.map((w) => w.code)).not.toContain('mixed_decision_classes');
    // Every candidate carries a full snapshot, not a partial one.
    for (const c of result.candidates) {
      expect(c.policy.approval_tier.state).toBe('known');
      expect(c.policy.constraint_notes.length).toBeGreaterThan(0);
      expect(c.evidence.window_start).toBeTruthy();
      expect(c.expected_outcome.measured_state).toBeDefined();
    }
  });

  test('resolves candidate kind when the caller does not supply it', () => {
    const a = insertTask({ title: 'A' });
    const b = insertStrategy({ name: 'B' });
    const result = buildComparison(BIZ_A, [{ id: a }, { id: b }]);
    expect(result.candidates.find((c) => c.id === a)!.kind).toBe('task');
    expect(result.candidates.find((c) => c.id === b)!.kind).toBe('strategy');
  });

  test('mixed decision classes are FLAGGED, not rejected', () => {
    const a = insertTask({ title: 'A task' });
    const b = insertStrategy({ name: 'A strategy' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'strategy' }]);
    expect(result.comparability.status).toBe('flagged');
    expect(result.comparability.warnings.map((w) => w.code)).toContain('mixed_decision_classes');
    expect(result.candidates).toHaveLength(2);
  });

  test('listComparableCandidates is scoped to one business', () => {
    insertTask({ business_id: BIZ_A, title: 'Mine' });
    insertTask({ business_id: BIZ_B, title: 'Theirs' });
    const pool = listComparableCandidates(BIZ_A);
    expect(pool.map((c) => c.title)).toContain('Mine');
    expect(pool.map((c) => c.title)).not.toContain('Theirs');
  });
});

// ─── Cross-business rejection ───────────────────────────────────────────────

describe('buildComparison — cross-business and malformed sets are rejected', () => {
  test('rejects a candidate belonging to another business', () => {
    const mine = insertTask({ business_id: BIZ_A, title: 'Mine' });
    const theirs = insertTask({ business_id: BIZ_B, title: 'Theirs' });

    let error: ComparisonRejectedError | null = null;
    try {
      buildComparison(BIZ_A, [{ id: mine, kind: 'task' }, { id: theirs, kind: 'task' }]);
    } catch (err) {
      error = err as ComparisonRejectedError;
    }

    expect(error).toBeInstanceOf(ComparisonRejectedError);
    const codes = error!.rejections.map((r) => r.code);
    expect(codes).toContain('cross_business_candidate');
    const rejection = error!.rejections.find((r) => r.code === 'cross_business_candidate')!;
    expect(rejection.candidate_id).toBe(theirs);
    expect(rejection.message).toContain(BIZ_B);
    // The reason names WHY, not just that it failed.
    expect(rejection.message.toLowerCase()).toContain('operating polic');
  });

  test('rejects an unknown candidate id rather than dropping it', () => {
    const a = insertTask();
    const codes = (() => {
      try { buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: 'does_not_exist', kind: 'task' }]); } catch (err) {
        return (err as ComparisonRejectedError).rejections.map((r) => r.code);
      }
      throw new Error('expected rejection');
    })();
    expect(codes).toContain('candidate_not_found');
  });

  test('rejects fewer than two candidates, duplicates, and oversized sets', () => {
    const a = insertTask();
    const only = (() => {
      try { buildComparison(BIZ_A, [{ id: a, kind: 'task' }]); } catch (err) {
        return (err as ComparisonRejectedError).rejections.map((r) => r.code);
      }
      throw new Error('expected rejection');
    })();
    expect(only).toContain('too_few_candidates');

    const dupes = (() => {
      try { buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: a, kind: 'task' }]); } catch (err) {
        return (err as ComparisonRejectedError).rejections.map((r) => r.code);
      }
      throw new Error('expected rejection');
    })();
    expect(dupes).toContain('duplicate_candidate');

    const many = Array.from({ length: MAX_COMPARISON_CANDIDATES + 1 }, () => ({ id: insertTask(), kind: 'task' as const }));
    const oversized = (() => {
      try { buildComparison(BIZ_A, many); } catch (err) {
        return (err as ComparisonRejectedError).rejections.map((r) => r.code);
      }
      throw new Error('expected rejection');
    })();
    expect(oversized).toContain('too_many_candidates');
  });
});

// ─── Unknowns are marked, never fabricated ──────────────────────────────────

describe('buildComparison — unknown and incomparable fields are marked', () => {
  test('a task with no cost, effort, impact or confidence reports unknown with reasons', () => {
    const bare = insertTask({ title: 'Bare task', confidence: null, estimated_impact: null, target_metric: null });
    const other = insertTask({ title: 'Other task' });

    const result = buildComparison(BIZ_A, [{ id: bare, kind: 'task' }, { id: other, kind: 'task' }]);
    const c = result.candidates.find((x) => x.id === bare)!;

    for (const field of [c.cost.estimated_cost, c.cost.estimated_effort, c.cost.financial_exposure_gbp, c.cost.time_to_impact_days]) {
      expect(field.state).toBe('unknown');
      expect(field.value).toBeNull();
      expect(field.reason).toBeTruthy();
    }
    expect(c.risk.agent_confidence.state).toBe('unknown');
    expect(c.risk.agent_confidence.value).toBeNull();
    expect(c.expected_outcome.expected_impact.state).toBe('unknown');
    expect(c.expected_outcome.target_metric.state).toBe('unknown');

    // "Not stated" must never be rendered as zero.
    expect(c.cost.financial_exposure_gbp.reason).toContain('not "zero"');
  });

  test('every unknown appears in the missing_data markers with a reason', () => {
    const bare = insertTask({ title: 'Bare', confidence: null, estimated_impact: null, target_metric: null });
    const other = insertTask({ title: 'Other' });
    const result = buildComparison(BIZ_A, [{ id: bare, kind: 'task' }, { id: other, kind: 'task' }]);

    const markers = result.missing_data.filter((m) => m.candidate_id === bare);
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(['unknown', 'not_comparable']).toContain(m.state);
      expect(m.reason.length).toBeGreaterThan(10);
    }
    expect(markers.map((m) => m.field)).toContain('cost.estimated_cost');
    expect(markers.map((m) => m.field)).toContain('risk.agent_confidence');
  });

  test('a known field always carries a citation; an unknown one never carries a value', () => {
    const withCost = insertStrategy({ name: 'Costed', estimated_cost: 400 });
    const withoutCost = insertStrategy({ name: 'Uncosted', estimated_cost: null });
    const result = buildComparison(BIZ_A, [{ id: withCost, kind: 'strategy' }, { id: withoutCost, kind: 'strategy' }]);

    const known = result.candidates.find((c) => c.id === withCost)!.cost.estimated_cost;
    expect(known.state).toBe('known');
    expect(known.value).toBe(400);
    expect(known.citation).toContain('goal_strategies#');

    const missing = result.candidates.find((c) => c.id === withoutCost)!.cost.estimated_cost;
    expect(missing.state).toBe('unknown');
    expect(missing.value).toBeNull();
    expect(missing.citation).toBeNull();
  });

  test('no historical track record is reported as unknown, not as 0% success', () => {
    const a = insertTask({ action_type: 'brand_new_action_type_xyz' });
    const b = insertTask({ action_type: 'brand_new_action_type_xyz' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);
    for (const c of result.candidates) {
      expect(c.expected_outcome.historical_success_rate.state).toBe('unknown');
      expect(c.expected_outcome.historical_success_rate.value).toBeNull();
      expect(c.expected_outcome.historical_sample_size).toBe(0);
    }
    expect(result.comparability.warnings.map((w) => w.code)).toContain('no_measured_track_record');
  });

  test('an undecided candidate reports the "activity" taxonomy state, not an outcome', () => {
    const a = insertTask({ status: 'proposed' });
    const b = insertTask({ status: 'proposed' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);
    for (const c of result.candidates) {
      expect(c.expected_outcome.measured_state).toBe('activity');
      expect(c.expected_outcome.measured_reason).toContain('proposed');
    }
  });
});

// ─── Shared vs differing ────────────────────────────────────────────────────

describe('buildComparison — shared vs differing dimensions', () => {
  test('the same policy version applies to every candidate and is reported once', () => {
    savePolicyVersion({
      scope: 'business', key: BIZ_A, actor: ACTOR,
      patch: { approvals: { auto_approve_max_tier: 'green' } },
    });
    const a = insertTask({ title: 'A' });
    const b = insertTask({ title: 'B' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);

    expect(result.shared_policy.policy_version).toBe(1);
    expect(result.shared_policy.policy_scope).toBe('business');
    expect(result.shared_policy.approvals.auto_approve_max_tier).toBe('green');
    // Each candidate's tier evidence cites the SAME policy the comparison used.
    for (const c of result.candidates) {
      expect(c.policy.tier_evidence.policy_version).toBe(1);
      expect(c.policy.tier_evidence.policy_id).toBe(result.shared_policy.policy_id);
    }
  });

  test('identical values become a shared dimension; different values become differing', () => {
    const a = insertTask({ title: 'Confident', confidence: 0.9, action_type: 'content_draft' });
    const b = insertTask({ title: 'Unsure', confidence: 0.2, action_type: 'content_draft' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);

    const byKey = new Map(result.dimensions.map((d) => [d.key, d]));

    // Same action type, same class → shared.
    const cls = byKey.get('decision_class')!;
    expect(cls.status).toBe('shared');
    expect(cls.shared_value).toBe('task:internal_idempotent');
    expect(result.shared_dimension_keys).toContain('decision_class');

    // Different confidence → differing.
    const conf = byKey.get('agent_confidence')!;
    expect(conf.status).toBe('differing');
    expect(result.differing_dimension_keys).toContain('agent_confidence');
    expect(conf.values.find((v) => v.candidate_id === a)!.value).toBe(0.9);
    expect(conf.values.find((v) => v.candidate_id === b)!.value).toBe(0.2);
  });

  test('a dimension nobody has a value for is unknown_for_all, not shared', () => {
    const a = insertTask({ title: 'A', target_metric: null });
    const b = insertTask({ title: 'B', target_metric: null });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);

    const dim = result.dimensions.find((d) => d.key === 'target_metric')!;
    expect(dim.status).toBe('unknown_for_all');
    expect(dim.shared_value).toBeNull();
    expect(result.unknown_dimension_keys).toContain('target_metric');
    expect(result.shared_dimension_keys).not.toContain('target_metric');
  });

  test('agreement among known values with a gap elsewhere is NOT reported as shared', () => {
    const withEffort = insertStrategy({ name: 'A', estimated_effort: 'medium' });
    const noEffort = insertStrategy({ name: 'B', estimated_effort: null });
    const result = buildComparison(BIZ_A, [{ id: withEffort, kind: 'strategy' }, { id: noEffort, kind: 'strategy' }]);

    const dim = result.dimensions.find((d) => d.key === 'estimated_effort')!;
    expect(dim.status).toBe('differing');
    expect(dim.unknown_candidate_ids).toEqual([noEffort]);
    expect(dim.values.find((v) => v.candidate_id === noEffort)!.display).toBe('unknown');
  });

  test('a differing policy outcome between candidates is visible as a trade-off', () => {
    savePolicyVersion({
      scope: 'business', key: BIZ_A, actor: ACTOR,
      patch: { approvals: { auto_approve_max_tier: 'green' } },
    });
    // 'customer' is an always-red keyword in the action type; the plain task stays lower.
    const risky = insertTask({ title: 'Email the customer list', action_type: 'customer_email' });
    const safe = insertTask({ title: 'Draft internal note', action_type: null, confidence: 0.9 });

    const result = buildComparison(BIZ_A, [{ id: risky, kind: 'task' }, { id: safe, kind: 'task' }]);
    const tier = result.dimensions.find((d) => d.key === 'approval_tier')!;
    expect(tier.status).toBe('differing');
    const riskyTier = tier.values.find((v) => v.candidate_id === risky)!.value;
    const safeTier = tier.values.find((v) => v.candidate_id === safe)!.value;
    expect(riskyTier).toBe('red');
    expect(safeTier).not.toBe('red');

    const ceiling = result.dimensions.find((d) => d.key === 'clears_auto_approve_ceiling')!;
    expect(ceiling.values.find((v) => v.candidate_id === risky)!.value).toBe(false);
  });

  test('with no auto-approve ceiling set, "clears the ceiling" is unknown rather than assumed true', () => {
    const a = insertTask({ title: 'A' });
    const b = insertTask({ title: 'B' });
    const result = buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);
    for (const c of result.candidates) {
      expect(c.policy.clears_auto_approve_ceiling.state).toBe('unknown');
      expect(c.policy.clears_auto_approve_ceiling.reason).toContain('auto_approve_max_tier');
    }
  });

  test('the shared evidence window covers every candidate', () => {
    const old = insertTask({ title: 'Old', created_at: new Date(Date.now() - 60 * 86400000).toISOString() });
    const fresh = insertTask({ title: 'Fresh' });
    const result = buildComparison(BIZ_A, [{ id: old, kind: 'task' }, { id: fresh, kind: 'task' }]);

    expect(new Date(result.shared_evidence_window.start).getTime())
      .toBeLessThanOrEqual(new Date(result.candidates[0]!.created_at).getTime());
    expect(result.shared_evidence_window.span_days).toBeGreaterThan(50);
    expect(result.comparability.warnings.map((w) => w.code)).toContain('divergent_evidence_windows');
  });
});

// ─── Zero side effects ──────────────────────────────────────────────────────

describe('buildComparison — entering comparison mode does nothing', () => {
  test('comparing creates no execution jobs and approves nothing', () => {
    const a = insertTask({ title: 'A', action_type: 'shopify_page_create' });
    const b = insertTask({ title: 'B', action_type: 'content_draft' });

    const beforeJobs = countRows('execution_jobs');
    const beforeDecisions = countRows('decisions');
    const beforeAudit = countRows('audit_log');
    const beforeTasks = db.prepare('SELECT id, status, approved_by, approved_at, updated_at FROM tasks WHERE id IN (?, ?) ORDER BY id').all(a, b);

    // Build it repeatedly — idempotent and inert.
    buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);
    buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);
    listComparableCandidates(BIZ_A);

    expect(countRows('execution_jobs')).toBe(beforeJobs);
    expect(countRows('execution_jobs')).toBe(0);
    expect(countRows('decisions')).toBe(beforeDecisions);
    expect(countRows('audit_log')).toBe(beforeAudit);
    expect(db.prepare('SELECT id, status, approved_by, approved_at, updated_at FROM tasks WHERE id IN (?, ?) ORDER BY id').all(a, b))
      .toEqual(beforeTasks);
  });

  test('the engine imports nothing that could execute or approve', async () => {
    // A structural guard, not a behavioural one: the zero-side-effect
    // property is easiest to break by importing an executor "just to read
    // one field", so the import list itself is asserted.
    const source = await Bun.file(new URL('./comparison-engine.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    const forbidden = imports.filter((spec) =>
      /executor|execution-worker|task-queue|approval|dispatch/i.test(spec));
    expect(forbidden).toEqual([]);
  });

  test('comparing writes no applicability suppression for an inapplicable candidate', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM applicability_suppressions WHERE business_id = ?').get(BIZ_A) as { n: number }).n;
    const a = insertTask({ title: 'Update the Shopify product', action_type: 'shopify_product_update' });
    const b = insertTask({ title: 'Update the Etsy listing', action_type: 'etsy_listing_update' });

    buildComparison(BIZ_A, [{ id: a, kind: 'task' }, { id: b, kind: 'task' }]);

    const after = (db.prepare('SELECT COUNT(*) AS n FROM applicability_suppressions WHERE business_id = ?').get(BIZ_A) as { n: number }).n;
    expect(after).toBe(before);
  });
});

// ─── Recording the decision ─────────────────────────────────────────────────

describe('recordComparisonDecision', () => {
  test('a selection writes one decision with rationale, policy version and alternatives', () => {
    savePolicyVersion({
      scope: 'business', key: BIZ_A, actor: ACTOR,
      patch: { approvals: { auto_approve_max_tier: 'green' } },
    });
    const winner = insertTask({ title: 'Winner', confidence: 0.77 });
    const loser = insertTask({ title: 'Loser', confidence: 0.4 });

    const record = recordComparisonDecision({
      business_id: BIZ_A,
      candidates: [{ id: winner, kind: 'task' }, { id: loser, kind: 'task' }],
      outcome: 'selected',
      selected_candidate_id: winner,
      rationale: 'Higher confidence and the same policy tier, so it is the cheaper bet.',
      actor: ACTOR,
    });

    expect(record.outcome).toBe('selected');
    expect(record.selected_candidate_id).toBe(winner);
    expect(record.executed).toBe(false);
    expect(record.approved).toBe(false);
    expect(record.policy_version).toBe(1);
    expect(record.policy_scope).toBe('business');

    const rows = db.prepare('SELECT * FROM decisions WHERE business_id = ?').all(BIZ_A) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(record.decision_id);
    expect(row.decision_type).toBe('comparison_selection');
    expect(row.reasoning).toBe('Higher confidence and the same policy tier, so it is the cheaper bet.');
    expect(row.author).toBe(ACTOR);
    expect(row.related_task_id).toBe(winner);
    expect(row.effective_policy_version).toBe(1);
    expect(row.effective_policy_id).toBe(record.policy_id);
    expect(row.effective_policy_scope).toBe('business');
    expect(row.confidence).toBe(0.77);

    const alternatives = JSON.parse(String(row.alternatives_rejected)) as Array<Record<string, unknown>>;
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]!.id).toBe(loser);

    const evidence = JSON.parse(String(row.evidence)) as Array<Record<string, unknown>>;
    expect(evidence[0]!.type).toBe('comparison');
    expect(String(evidence[0]!.policy_citation)).toContain('business policy v1');
  });

  test('a selection does NOT approve or execute the winning candidate', () => {
    const winner = insertTask({ title: 'Winner' });
    const loser = insertTask({ title: 'Loser' });

    recordComparisonDecision({
      business_id: BIZ_A,
      candidates: [{ id: winner, kind: 'task' }, { id: loser, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: winner,
      rationale: 'Preferred, but still needs the normal approval step.',
      actor: ACTOR,
    });

    const row = db.prepare('SELECT status, approved_by, approved_at FROM tasks WHERE id = ?').get(winner) as Record<string, unknown>;
    expect(row.status).toBe('proposed');
    expect(row.approved_by).toBeNull();
    expect(row.approved_at).toBeNull();
    expect(countRows('execution_jobs')).toBe(0);
  });

  test('a deferral records the same evidence without picking a winner', () => {
    const a = insertTask({ title: 'A' });
    const b = insertTask({ title: 'B' });

    const record = recordComparisonDecision({
      business_id: BIZ_A,
      candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'deferred',
      rationale: 'Neither has a measured track record; revisit after the next outcome window.',
      actor: ACTOR,
    });

    expect(record.selected_candidate_id).toBeNull();
    expect(record.executed).toBe(false);

    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(record.decision_id) as Record<string, unknown>;
    expect(row.decision_type).toBe('comparison_deferral');
    expect(row.related_task_id).toBeNull();
    // No winner means no borrowed confidence.
    expect(row.confidence).toBeNull();
    expect(row.reasoning).toContain('measured track record');
    expect(row.effective_policy_version).toBe(0); // system default — still a real citation
    expect(row.effective_policy_scope).toBe('system_default');

    const alternatives = JSON.parse(String(row.alternatives_rejected)) as Array<Record<string, unknown>>;
    expect(alternatives).toHaveLength(2);
    expect(String(alternatives[0]!.not_selected_reason)).toContain('deferred');
  });

  test('a rationale is mandatory and no decision is written without one', () => {
    const a = insertTask();
    const b = insertTask();
    expect(() => recordComparisonDecision({
      business_id: BIZ_A, candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: a, rationale: '   ', actor: ACTOR,
    })).toThrow(/rationale is required/i);
    expect(countRows('decisions')).toBe(0);
  });

  test('a selection must name one of the compared candidates', () => {
    const a = insertTask();
    const b = insertTask();
    const outsider = insertTask();
    expect(() => recordComparisonDecision({
      business_id: BIZ_A, candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: outsider, rationale: 'x', actor: ACTOR,
    })).toThrow(/not one of the compared candidates/);
    expect(countRows('decisions')).toBe(0);
  });

  test('a deferral must not name a winner', () => {
    const a = insertTask();
    const b = insertTask();
    expect(() => recordComparisonDecision({
      business_id: BIZ_A, candidates: [{ id: a, kind: 'task' }, { id: b, kind: 'task' }],
      outcome: 'deferred', selected_candidate_id: a, rationale: 'x', actor: ACTOR,
    })).toThrow(/must not name a selected_candidate_id/);
    expect(countRows('decisions')).toBe(0);
  });

  test('recording re-validates business scope — a cross-business set is still rejected', () => {
    const mine = insertTask({ business_id: BIZ_A });
    const theirs = insertTask({ business_id: BIZ_B });
    expect(() => recordComparisonDecision({
      business_id: BIZ_A, candidates: [{ id: mine, kind: 'task' }, { id: theirs, kind: 'task' }],
      outcome: 'selected', selected_candidate_id: mine, rationale: 'x', actor: ACTOR,
    })).toThrow(ComparisonRejectedError);
    expect(countRows('decisions')).toBe(0);
  });
});
