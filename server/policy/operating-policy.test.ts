/**
 * Per-business Operating Policy engine (#68).
 *
 * Covers the guarantees the feature actually promises: typed versioning
 * that never mutates or deletes, validation that names the specific
 * problem, previews with zero side effects, scheduled activation,
 * rollback-as-a-new-version, inheritance from an explicitly selected
 * portfolio, and cross-business isolation.
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import db from '../db/db.js';
import {
  DEFAULT_OPERATING_POLICY, PolicyValidationError,
  activateDuePolicies, cancelScheduledPolicy, computeTierUnderPolicy, diffPolicyDocuments,
  effectiveDailyTaskCap, evaluateAutonomyGate, getActivePolicyVersion, getPolicyVersion,
  listPolicyEvents, listPolicyVersions, mergePolicyDocument, previewPolicyChange,
  resolveOperatingPolicy, rollbackPolicy, savePolicyVersion, upsertPolicyPortfolio,
  validatePolicyDocument,
} from './operating-policy.js';

const BIZ_A = 'biz_oppolicy_a';
const BIZ_B = 'biz_oppolicy_b';
const BIZ_C = 'biz_oppolicy_c';
const ACTOR = 'dashboard:test-operator';

beforeAll(() => {
  const fixtures: Array<[string, string, string]> = [
    [BIZ_A, 'Policy Test A', 'policy-test-a'],
    [BIZ_B, 'Policy Test B', 'policy-test-b'],
    [BIZ_C, 'Policy Test C', 'policy-test-c'],
  ];
  for (const [id, name, slug] of fixtures) {
    db.prepare('INSERT INTO businesses (id, name, slug) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, name, slug);
  }
});

afterEach(() => {
  const ids = [BIZ_A, BIZ_B, BIZ_C];
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM operating_policies WHERE scope_key IN (${ph}) OR portfolio_id IN (SELECT id FROM operating_policy_portfolios)`).run(...ids);
  db.prepare('DELETE FROM operating_policies WHERE scope = ?').run('portfolio');
  db.prepare(`DELETE FROM operating_policy_events WHERE scope_key IN (${ph}) OR scope = 'portfolio'`).run(...ids);
  db.prepare('DELETE FROM operating_policy_portfolios').run();
  db.prepare(`DELETE FROM tasks WHERE business_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM connectors WHERE business_id IN (${ph})`).run(...ids);
});

function save(businessId: string, patch: Parameters<typeof savePolicyVersion>[0]['patch'], extra: Partial<Parameters<typeof savePolicyVersion>[0]> = {}) {
  return savePolicyVersion({ scope: 'business', key: businessId, patch, actor: ACTOR, ...extra });
}

function violationCodes(fn: () => unknown): string[] {
  try { fn(); } catch (err) {
    if (err instanceof PolicyValidationError) return err.violations.map((v) => v.code);
    throw err;
  }
  throw new Error('Expected the policy to be rejected, but it was accepted.');
}

// ─── Defaults & tier parity ─────────────────────────────────────────────────

describe('defaults', () => {
  test('a business with no policy resolves to system defaults, cited as version 0', () => {
    const resolved = resolveOperatingPolicy(BIZ_A);
    expect(resolved.policy_version).toBe(0);
    expect(resolved.policy_scope).toBe('system_default');
    expect(resolved.policy_id).toBeNull();
    expect(resolved.document).toEqual(DEFAULT_OPERATING_POLICY);
    expect(resolved.citation).toContain('system default');
  });

  test('default thresholds reproduce the pre-policy hardcoded tiering exactly', () => {
    const d = DEFAULT_OPERATING_POLICY;
    expect(computeTierUnderPolicy(d, { actionType: 'report', baseTier: 'green' })).toBe('green');
    expect(computeTierUnderPolicy(d, { actionType: 'github_pr', payload: { affected_records: 1 } })).toBe('orange');
    expect(computeTierUnderPolicy(d, { actionType: 'shopify_product_update', payload: { affected_records: 5000, financial_exposure_gbp: 750 } })).toBe('red');
    // 100 records is NOT above the review threshold; 101 is.
    expect(computeTierUnderPolicy(d, { actionType: 'report', baseTier: 'green', payload: { affected_records: 100 } })).toBe('green');
    expect(computeTierUnderPolicy(d, { actionType: 'report', baseTier: 'green', payload: { affected_records: 101 } })).toBe('orange');
  });

  test('thresholds are policy-driven — a stricter policy re-tiers the same action', () => {
    const strict = mergePolicyDocument(DEFAULT_OPERATING_POLICY, {
      thresholds: { financial_exposure_review_gbp: 10, financial_exposure_block_gbp: 50 },
    });
    const input = { actionType: 'report', baseTier: 'green' as const, payload: { financial_exposure_gbp: 60 } };
    expect(computeTierUnderPolicy(DEFAULT_OPERATING_POLICY, input)).toBe('green');
    expect(computeTierUnderPolicy(strict, input)).toBe('red');
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('validation rejects invalid, conflicting and unsafe policies with specific feedback', () => {
  test('a negative threshold names the field and the value', () => {
    const violations = validatePolicyDocument(
      mergePolicyDocument(DEFAULT_OPERATING_POLICY, { thresholds: { financial_exposure_review_gbp: -5 } }),
    );
    const v = violations.find((x) => x.code === 'threshold_negative');
    expect(v).toBeDefined();
    expect(v!.field).toBe('thresholds.financial_exposure_review_gbp');
    expect(v!.message).toContain('-5');
    expect(v!.message).toContain('never be crossed');
  });

  test('a review threshold at or above its block threshold is a named ordering conflict', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      thresholds: { financial_exposure_review_gbp: 900, financial_exposure_block_gbp: 500 },
    }));
    expect(codes).toContain('threshold_order_conflict');
  });

  test('confidence expressed as a percentage is caught with a corrective hint', () => {
    const violations = validatePolicyDocument(
      mergePolicyDocument(DEFAULT_OPERATING_POLICY, { thresholds: { min_agent_confidence: 55 } }),
    );
    const v = violations.find((x) => x.code === 'confidence_out_of_range');
    expect(v!.message).toContain('use 0.55, not 55');
  });

  test('an approval requirement that contradicts the auto-approval ceiling is rejected', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      approvals: { auto_approve_max_tier: 'orange', require_human_approval_at_or_above: 'yellow' },
    }));
    expect(codes).toContain('approval_contradiction');
  });

  test("auto-approving 'red' is unsafe and is NOT waivable", () => {
    const doc = mergePolicyDocument(DEFAULT_OPERATING_POLICY, {
      approvals: { auto_approve_max_tier: 'red', require_human_approval_at_or_above: 'red' },
      acknowledged_risks: ['unsafe_auto_approve_orange'],
    });
    const violations = validatePolicyDocument(doc);
    const v = violations.find((x) => x.code === 'unsafe_auto_approve_red');
    expect(v).toBeDefined();
    expect(v!.waivable).toBe(false);
    expect(v!.message).toContain('irreversible');
  });

  test("auto-approving 'orange' is unsafe but waivable by explicit acknowledgement", () => {
    const patch = { approvals: { auto_approve_max_tier: 'orange' as const, require_human_approval_at_or_above: 'red' as const } };
    expect(violationCodes(() => save(BIZ_A, patch))).toContain('unsafe_auto_approve_orange');

    const accepted = save(BIZ_A, { ...patch, acknowledged_risks: ['unsafe_auto_approve_orange'] });
    expect(accepted.document.approvals.auto_approve_max_tier).toBe('orange');
  });

  test('acknowledging a code that is not waivable is itself rejected', () => {
    const codes = violationCodes(() => save(BIZ_A, { acknowledged_risks: ['unsafe_auto_approve_red'] }));
    expect(codes).toContain('unknown_acknowledged_risk');
  });

  test('autonomy on with a zero daily cap is a contradiction with a concrete fix', () => {
    let message = '';
    try {
      save(BIZ_A, { autonomy: { allow_autonomous_execution: true, max_autonomous_tasks_per_day: 0 } });
    } catch (err) { message = (err as Error).message; }
    expect(message).toContain('autonomy_contradiction');
    expect(message).toContain('set allow_autonomous_execution to false');
  });

  test('autonomy off while a tier is still auto-approvable is a contradiction', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      autonomy: { allow_autonomous_execution: false },
      approvals: { auto_approve_max_tier: 'green' },
    }));
    expect(codes).toContain('autonomy_contradiction');
    // ...and the honest version of the same intent is accepted.
    const ok = save(BIZ_A, {
      autonomy: { allow_autonomous_execution: false },
      approvals: { auto_approve_max_tier: 'none' },
    });
    expect(ok.document.autonomy.allow_autonomous_execution).toBe(false);
  });

  test('a connector both allowed and blocked is rejected, naming the connector', () => {
    let message = '';
    try {
      save(BIZ_A, { connectors: { allowed_connector_types: ['shopify', 'stripe'], blocked_connector_types: ['shopify'] } });
    } catch (err) { message = (err as Error).message; }
    expect(message).toContain("'shopify'");
    expect(message).toContain('connector_allow_block_conflict');
  });

  test('a required connector that is also blocked can never be satisfied', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      connectors: { required_connector_types: ['stripe'], blocked_connector_types: ['stripe'] },
    }));
    expect(codes).toContain('connector_required_blocked');
  });

  test('a required connector outside a restricted allow-list is rejected', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      connectors: { allowed_connector_types: ['shopify'], required_connector_types: ['stripe'] },
    }));
    expect(codes).toContain('connector_required_not_allowed');
  });

  test('objective weights must be in range and sum to 1, and the message shows the actual sum', () => {
    let message = '';
    try { save(BIZ_A, { priorities: { objective_weights: { revenue: 0.6, risk: 0.6 } } }); }
    catch (err) { message = (err as Error).message; }
    expect(message).toContain('weights_sum_invalid');
    expect(message).toContain('1.200');
  });

  test('an unknown field is rejected and the valid fields are listed', () => {
    let message = '';
    try { save(BIZ_A, { thresholds: { max_spend: 10 } } as never); }
    catch (err) { message = (err as Error).message; }
    expect(message).toContain('unknown_field');
    expect(message).toContain('financial_exposure_review_gbp');
  });

  test('all problems in one edit are reported together, not one at a time', () => {
    const codes = violationCodes(() => save(BIZ_A, {
      thresholds: { financial_exposure_review_gbp: -1, min_agent_confidence: 9 },
      connectors: { allowed_connector_types: ['a'], blocked_connector_types: ['a'] },
    }));
    expect(codes).toContain('threshold_negative');
    expect(codes).toContain('confidence_out_of_range');
    expect(codes).toContain('connector_allow_block_conflict');
  });

  test('a rejected edit writes no version but leaves an audit trace of the attempt', () => {
    expect(() => save(BIZ_A, { thresholds: { financial_exposure_review_gbp: -1 } })).toThrow(PolicyValidationError);
    expect(listPolicyVersions({ scope: 'business', key: BIZ_A })).toHaveLength(0);
    const events = listPolicyEvents({ scope: 'business', key: BIZ_A });
    expect(events.some((e) => e.event_type === 'rejected')).toBe(true);
  });
});

// ─── Versioning ─────────────────────────────────────────────────────────────

describe('versioning', () => {
  test('each save is a new immutable version; the previous one is superseded, never deleted', () => {
    const v1 = save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 50 } }, { change_reason: 'Tighten spend review' });
    const v2 = save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 25 } }, { change_reason: 'Tighter still' });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.state).toBe('active');

    const stored = listPolicyVersions({ scope: 'business', key: BIZ_A });
    expect(stored).toHaveLength(2);
    const reread = getPolicyVersion({ scope: 'business', key: BIZ_A }, 1)!;
    expect(reread.state).toBe('superseded');
    expect(reread.superseded_by_id).toBe(v2.id);
    // The v1 document is untouched by the v2 edit.
    expect(reread.document.thresholds.financial_exposure_review_gbp).toBe(50);
  });

  test('a patch merges over the current version rather than replacing the whole document', () => {
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 40 }, notes: 'careful business' });
    const v2 = save(BIZ_A, { priorities: { max_open_tasks: 5 } });
    expect(v2.document.thresholds.financial_exposure_review_gbp).toBe(40);
    expect(v2.document.notes).toBe('careful business');
    expect(v2.document.priorities.max_open_tasks).toBe(5);
  });

  test('the audit trail records who changed which field, from what to what, and why', () => {
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 50 } }, { change_reason: 'Board decision 2026-08' });
    const created = listPolicyEvents({ scope: 'business', key: BIZ_A }).find((e) => e.event_type === 'created')!;
    expect(created.actor).toBe(ACTOR);
    expect(created.reason).toBe('Board decision 2026-08');
    const changes = created.changed_fields as Array<{ field: string; from: unknown; to: unknown }>;
    const change = changes.find((c) => c.field === 'thresholds.financial_exposure_review_gbp')!;
    expect(change.from).toBeNull();
    expect(change.to).toBe(50);
  });

  test('an edit from a stale base version is refused rather than silently overwriting', () => {
    save(BIZ_A, { notes: 'first' });
    save(BIZ_A, { notes: 'second' });
    expect(() => save(BIZ_A, { notes: 'third' }, { base_version: 1 }))
      .toThrow(/you are editing from version 1 but the current version is 2/i);
  });

  test('diffPolicyDocuments reports only the fields that actually differ', () => {
    const a = DEFAULT_OPERATING_POLICY;
    const b = mergePolicyDocument(a, { priorities: { max_open_tasks: 3 } });
    const diff = diffPolicyDocuments(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.field).toBe('priorities.max_open_tasks');
    expect(diff[0]!.to).toBe(3);
  });
});

// ─── Preview ────────────────────────────────────────────────────────────────

describe('preview', () => {
  test('preview validates and diffs without writing a version, event or activation', () => {
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 80 } });
    const versionsBefore = listPolicyVersions({ scope: 'business', key: BIZ_A }).length;
    const eventsBefore = listPolicyEvents({ scope: 'business', key: BIZ_A }).length;

    const preview = previewPolicyChange({ key: BIZ_A, patch: { thresholds: { financial_exposure_review_gbp: 20 } } });

    expect(preview.valid).toBe(true);
    expect(preview.current_version).toBe(1);
    expect(preview.next_version).toBe(2);
    expect(preview.changes.map((c) => c.field)).toContain('thresholds.financial_exposure_review_gbp');
    expect(listPolicyVersions({ scope: 'business', key: BIZ_A })).toHaveLength(versionsBefore);
    expect(listPolicyEvents({ scope: 'business', key: BIZ_A })).toHaveLength(eventsBefore);
    // The live policy is unchanged.
    expect(resolveOperatingPolicy(BIZ_A).document.thresholds.financial_exposure_review_gbp).toBe(80);
  });

  test('preview reports violations instead of throwing, so a form can render them', () => {
    const preview = previewPolicyChange({ key: BIZ_A, patch: { thresholds: { financial_exposure_review_gbp: -3 } } });
    expect(preview.valid).toBe(false);
    expect(preview.violations.map((v) => v.code)).toContain('threshold_negative');
    expect(listPolicyVersions({ scope: 'business', key: BIZ_A })).toHaveLength(0);
  });

  test('preview computes which currently-open tasks would change approval tier', () => {
    db.prepare(`
      INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, action_payload, applicability_status, created_at, updated_at)
      VALUES ('task_prev_1', ?, 'Spend a bit', 'test', 'proposed', 'green', ?, 'applicable', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(BIZ_A, JSON.stringify({ financial_exposure_gbp: 30 }));

    const preview = previewPolicyChange({
      key: BIZ_A,
      patch: { thresholds: { financial_exposure_review_gbp: 10, financial_exposure_block_gbp: 20 } },
    });
    const impact = preview.impacts.find((i) => i.kind === 'task_retiering')!;
    expect(impact).toBeDefined();
    const tasks = (impact.detail as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.from).toBe('green');
    expect(tasks[0]!.to).toBe('red');
  });

  test('preview reports connectors that a new block rule would take out of service', () => {
    db.prepare("INSERT INTO connectors (id, business_id, type, name, status) VALUES ('con_prev_1', ?, 'shopify', 'Shop', 'connected')").run(BIZ_A);
    const preview = previewPolicyChange({ key: BIZ_A, patch: { connectors: { blocked_connector_types: ['shopify'] } } });
    const impact = preview.impacts.find((i) => i.kind === 'connector_applicability')!;
    expect(impact.summary).toContain('shopify');
  });
});

// ─── Scheduling ─────────────────────────────────────────────────────────────

describe('scheduled activation', () => {
  test('a future effective_at is scheduled, not applied, and the old version stays active', () => {
    save(BIZ_A, { priorities: { max_open_tasks: 10 } });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduled = save(BIZ_A, { priorities: { max_open_tasks: 2 } }, { effective_at: future });

    expect(scheduled.state).toBe('scheduled');
    expect(scheduled.activated_at).toBeNull();
    expect(getActivePolicyVersion({ scope: 'business', key: BIZ_A })!.version).toBe(1);
    expect(resolveOperatingPolicy(BIZ_A).document.priorities.max_open_tasks).toBe(10);
  });

  test('a scheduled version activates on the first resolve after its effective_at', () => {
    save(BIZ_A, { priorities: { max_open_tasks: 10 } });
    const soon = new Date(Date.now() + 50).toISOString();
    const scheduled = save(BIZ_A, { priorities: { max_open_tasks: 2 } }, { effective_at: soon });
    expect(scheduled.state).toBe('scheduled');

    // Fast-forward by rewriting effective_at into the past — the same thing
    // the passage of time would do, without sleeping in a test.
    db.prepare('UPDATE operating_policies SET effective_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), scheduled.id);

    const resolved = resolveOperatingPolicy(BIZ_A);
    expect(resolved.policy_version).toBe(2);
    expect(resolved.document.priorities.max_open_tasks).toBe(2);
    expect(getPolicyVersion({ scope: 'business', key: BIZ_A }, 1)!.state).toBe('superseded');
    expect(listPolicyEvents({ scope: 'business', key: BIZ_A }).some((e) => e.event_type === 'activated' && e.version === 2)).toBe(true);
  });

  test('activation is idempotent — a second pass activates nothing more', () => {
    save(BIZ_A, { notes: 'v1' });
    const scheduled = save(BIZ_A, { notes: 'v2' }, { effective_at: new Date(Date.now() + 3600_000).toISOString() });
    db.prepare('UPDATE operating_policies SET effective_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), scheduled.id);

    expect(activateDuePolicies({ scope: 'business', key: BIZ_A })).toBe(1);
    expect(activateDuePolicies({ scope: 'business', key: BIZ_A })).toBe(0);
  });

  test('a scheduled version can be cancelled before it takes effect, keeping its history', () => {
    save(BIZ_A, { notes: 'live' });
    const scheduled = save(BIZ_A, { notes: 'planned' }, { effective_at: new Date(Date.now() + 3600_000).toISOString() });
    const cancelled = cancelScheduledPolicy({ key: BIZ_A, version: scheduled.version, actor: ACTOR, reason: 'Changed our mind' });

    expect(cancelled.state).toBe('superseded');
    expect(listPolicyVersions({ scope: 'business', key: BIZ_A })).toHaveLength(2); // nothing deleted
    expect(getActivePolicyVersion({ scope: 'business', key: BIZ_A })!.version).toBe(1);
    expect(activateDuePolicies({ scope: 'business', key: BIZ_A })).toBe(0);
  });

  test('an already-active version cannot be cancelled as if it were scheduled', () => {
    const v1 = save(BIZ_A, { notes: 'live' });
    expect(() => cancelScheduledPolicy({ key: BIZ_A, version: v1.version, actor: ACTOR }))
      .toThrow(/is 'active', not 'scheduled'/);
  });

  test('an unparseable effective_at is rejected with an example of the right format', () => {
    expect(() => save(BIZ_A, { notes: 'x' }, { effective_at: 'next tuesday' }))
      .toThrow(/not a valid ISO-8601 timestamp/);
  });
});

// ─── Rollback ───────────────────────────────────────────────────────────────

describe('rollback', () => {
  test('rollback restores an old document as a NEW version, keeping full history', () => {
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 100 } }, { change_reason: 'baseline' });
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 5 } }, { change_reason: 'too strict, as it turned out' });

    const rolled = rollbackPolicy({ key: BIZ_A, to_version: 1, actor: ACTOR, change_reason: 'v2 blocked everything' });

    expect(rolled.version).toBe(3);
    expect(rolled.source).toBe('rollback');
    expect(rolled.rolled_back_from_version).toBe(1);
    expect(rolled.document.thresholds.financial_exposure_review_gbp).toBe(100);
    expect(resolveOperatingPolicy(BIZ_A).policy_version).toBe(3);
    // Nothing was deleted or rewound.
    expect(listPolicyVersions({ scope: 'business', key: BIZ_A }).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(getPolicyVersion({ scope: 'business', key: BIZ_A }, 2)!.document.thresholds.financial_exposure_review_gbp).toBe(5);
    expect(listPolicyEvents({ scope: 'business', key: BIZ_A }).some((e) => e.event_type === 'rolled_back')).toBe(true);
  });

  test('rollback restores fields a later version added, not just the ones it changed', () => {
    save(BIZ_A, { notes: 'original' });
    save(BIZ_A, { notes: 'changed', priorities: { max_open_tasks: 4 } });
    const rolled = rollbackPolicy({ key: BIZ_A, to_version: 1, actor: ACTOR });
    expect(rolled.document.notes).toBe('original');
    expect(rolled.document.priorities.max_open_tasks).toBeNull();
  });

  test('rolling back to a non-existent version lists the versions that do exist', () => {
    save(BIZ_A, { notes: 'only one' });
    expect(() => rollbackPolicy({ key: BIZ_A, to_version: 9, actor: ACTOR }))
      .toThrow(/Version 9 does not exist.*Available versions: 1/s);
  });

  test('rolling back to the version already active is refused as a no-op', () => {
    save(BIZ_A, { notes: 'one' });
    expect(() => rollbackPolicy({ key: BIZ_A, to_version: 1, actor: ACTOR }))
      .toThrow(/already the active policy/);
  });
});

// ─── Portfolio inheritance ──────────────────────────────────────────────────

describe('portfolio scope and inheritance', () => {
  test('a portfolio policy applies to its members and a business policy overrides it', () => {
    const portfolio = upsertPolicyPortfolio({ name: 'Retail group', business_ids: [BIZ_A, BIZ_B], actor: ACTOR });
    savePolicyVersion({
      scope: 'portfolio', key: portfolio.id, actor: ACTOR,
      patch: { thresholds: { financial_exposure_review_gbp: 25 }, priorities: { max_open_tasks: 7 } },
    });

    const b = resolveOperatingPolicy(BIZ_B);
    expect(b.policy_scope).toBe('portfolio');
    expect(b.document.thresholds.financial_exposure_review_gbp).toBe(25);
    expect(b.document.priorities.max_open_tasks).toBe(7);

    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 5 } });
    const a = resolveOperatingPolicy(BIZ_A);
    expect(a.policy_scope).toBe('business');
    expect(a.document.thresholds.financial_exposure_review_gbp).toBe(5); // business wins
    expect(a.document.priorities.max_open_tasks).toBe(7);                // inherited
    expect(a.citation).toContain('inheriting portfolio');
    // A non-member is untouched by either.
    expect(resolveOperatingPolicy(BIZ_C).policy_version).toBe(0);
  });

  test('a business may not belong to two portfolios — ambiguous inheritance is refused', () => {
    upsertPolicyPortfolio({ name: 'Group one', business_ids: [BIZ_A], actor: ACTOR });
    expect(() => upsertPolicyPortfolio({ name: 'Group two', business_ids: [BIZ_A, BIZ_B], actor: ACTOR }))
      .toThrow(/already belongs to portfolio 'Group one'/);
  });

  test('a portfolio must explicitly select at least one real business', () => {
    expect(() => upsertPolicyPortfolio({ name: 'Empty', business_ids: [], actor: ACTOR }))
      .toThrow(/at least one business/);
    expect(() => upsertPolicyPortfolio({ name: 'Ghosts', business_ids: ['biz_does_not_exist'], actor: ACTOR }))
      .toThrow(/Unknown business id/);
  });
});

// ─── Cross-business isolation ───────────────────────────────────────────────

describe('cross-business isolation', () => {
  test("one business's policy is invisible to and unaffected by another's", () => {
    save(BIZ_A, { thresholds: { financial_exposure_review_gbp: 10 } });
    save(BIZ_B, { thresholds: { financial_exposure_review_gbp: 400 } });

    expect(resolveOperatingPolicy(BIZ_A).document.thresholds.financial_exposure_review_gbp).toBe(10);
    expect(resolveOperatingPolicy(BIZ_B).document.thresholds.financial_exposure_review_gbp).toBe(400);
    expect(resolveOperatingPolicy(BIZ_C).document.thresholds.financial_exposure_review_gbp)
      .toBe(DEFAULT_OPERATING_POLICY.thresholds.financial_exposure_review_gbp);

    expect(listPolicyVersions({ scope: 'business', key: BIZ_A })).toHaveLength(1);
    expect(listPolicyVersions({ scope: 'business', key: BIZ_C })).toHaveLength(0);
    expect(listPolicyEvents({ scope: 'business', key: BIZ_C })).toHaveLength(0);
  });

  test('version numbers are per-business, and one business cannot read another version by number', () => {
    save(BIZ_A, { notes: 'a1' });
    save(BIZ_A, { notes: 'a2' });
    const b1 = save(BIZ_B, { notes: 'b1' });

    expect(b1.version).toBe(1); // B starts at 1 despite A being on 2
    expect(getPolicyVersion({ scope: 'business', key: BIZ_B }, 2)).toBeNull();
    expect(getPolicyVersion({ scope: 'business', key: BIZ_A }, 2)!.document.notes).toBe('a2');
  });

  test('rolling back one business does not touch another', () => {
    save(BIZ_A, { notes: 'a1' });
    save(BIZ_A, { notes: 'a2' });
    save(BIZ_B, { notes: 'b1' });

    rollbackPolicy({ key: BIZ_A, to_version: 1, actor: ACTOR });

    expect(resolveOperatingPolicy(BIZ_A).document.notes).toBe('a1');
    expect(resolveOperatingPolicy(BIZ_B).document.notes).toBe('b1');
    expect(listPolicyVersions({ scope: 'business', key: BIZ_B })).toHaveLength(1);
  });

  test('saving a policy for a business that does not exist is refused', () => {
    expect(() => save('biz_never_created', { notes: 'x' })).toThrow(/Business 'biz_never_created' not found/);
  });
});

// ─── Autonomy gate ──────────────────────────────────────────────────────────

describe('autonomy gate', () => {
  test('the master switch blocks autonomous approval but never a human', () => {
    save(BIZ_A, { autonomy: { allow_autonomous_execution: false }, approvals: { auto_approve_max_tier: 'none' } });

    const agent = evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:some-agent' });
    expect(agent.allowed).toBe(false);
    expect(agent.code).toBe('autonomy_disabled');
    expect(agent.reason).toContain('business policy v1');

    expect(evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'dashboard:alice' }).allowed).toBe(true);
  });

  test('dry-run mode blocks autonomous approval with its own distinguishable reason', () => {
    save(BIZ_A, { autonomy: { dry_run: true } });
    const gate = evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:agent' });
    expect(gate.code).toBe('autonomy_dry_run');
  });

  test('an action type on the always-require-human list is blocked whatever its tier', () => {
    save(BIZ_A, { approvals: { always_require_human_action_types: ['content_draft'] } });
    const gate = evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:agent', actionType: 'content_draft', tier: 'green' });
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('action_type_requires_human');
  });

  test('no ceiling is enforced by default — the opt-in default is null, not a silent gate', () => {
    expect(DEFAULT_OPERATING_POLICY.approvals.auto_approve_max_tier).toBeNull();
    expect(evaluateAutonomyGate({ businessId: BIZ_C, approvedBy: 'bap:a', tier: 'red' }).allowed).toBe(true);
  });

  test('a tier above an explicitly set auto-approval ceiling is blocked; one at or below is allowed', () => {
    save(BIZ_A, { approvals: { auto_approve_max_tier: 'green', require_human_approval_at_or_above: 'yellow' } });
    expect(evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:a', tier: 'green' }).allowed).toBe(true);
    const blocked = evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:a', tier: 'orange' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('tier_above_auto_approve_ceiling');
  });

  test('connector applicability rules gate actions by the connectors they need', () => {
    save(BIZ_A, { connectors: { blocked_connector_types: ['shopify'] } });
    const blocked = evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:a', tier: 'green', requiredConnectorTypes: ['shopify'] });
    expect(blocked.code).toBe('connector_blocked_by_policy');
    expect(evaluateAutonomyGate({ businessId: BIZ_A, approvedBy: 'bap:a', tier: 'green', requiredConnectorTypes: ['stripe'] }).allowed).toBe(true);

    save(BIZ_B, { connectors: { allowed_connector_types: ['stripe'] } });
    const notAllowed = evaluateAutonomyGate({ businessId: BIZ_B, approvedBy: 'bap:a', tier: 'green', requiredConnectorTypes: ['shopify'] });
    expect(notAllowed.code).toBe('connector_not_in_allow_list');
  });

  test('the stricter of the operating-policy cap and the legacy profile cap wins', () => {
    save(BIZ_A, { autonomy: { max_autonomous_tasks_per_day: 10 } });
    const policy = resolveOperatingPolicy(BIZ_A);
    expect(effectiveDailyTaskCap(policy, 3)).toEqual({ cap: 3, source: 'business_profile' });
    expect(effectiveDailyTaskCap(policy, 25)).toEqual({ cap: 10, source: 'operating_policy' });
    expect(effectiveDailyTaskCap(policy, null)).toEqual({ cap: 10, source: 'operating_policy' });
    expect(effectiveDailyTaskCap(resolveOperatingPolicy(BIZ_C), null)).toEqual({ cap: null, source: 'none' });
    expect(effectiveDailyTaskCap(resolveOperatingPolicy(BIZ_C), 4)).toEqual({ cap: 4, source: 'business_profile' });
  });
});
