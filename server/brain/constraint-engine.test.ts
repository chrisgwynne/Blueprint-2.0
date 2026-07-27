import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db, { generateId } from '../db/db.js';
import { checkConstraints, listConstraints } from './constraint-engine.js';

const BIZ = 'biz_constraint_engine_test';

function insertConstraint(overrides: Partial<Record<string, unknown>> = {}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO constraints (id, business_id, constraint_type, scope, limit_value, limit_unit, starts_at, ends_at, active, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, BIZ, (overrides.constraint_type as string) ?? 'manual',
    JSON.stringify(overrides.scope ?? {}),
    (overrides.limit_value as number) ?? null, (overrides.limit_unit as string) ?? null,
    (overrides.starts_at as string) ?? null, (overrides.ends_at as string) ?? null,
    overrides.active === false ? 0 : 1,
    (overrides.note as string) ?? null,
  );
  return id;
}

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Constraint Engine Test', 'constraint-engine-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM constraints WHERE business_id = ?`).run(BIZ);
});

describe('checkConstraints', () => {
  test('allowed with no constraints at all', () => {
    const result = checkConstraints(BIZ, { action_type: 'meta_update' });
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('a scoped freeze blocks a matching action_type but not others', () => {
    insertConstraint({ constraint_type: 'freeze', scope: { action_type: 'meta_ads_spend_increase' }, note: 'Q4 ad freeze' });
    const blocked = checkConstraints(BIZ, { action_type: 'meta_ads_spend_increase' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.violations[0]?.severity).toBe('blocking');

    const unaffected = checkConstraints(BIZ, { action_type: 'meta_update' });
    expect(unaffected.allowed).toBe(true);
  });

  test('an inactive constraint is ignored', () => {
    insertConstraint({ constraint_type: 'freeze', scope: { action_type: 'inactive_scope_type' }, active: false });
    const result = checkConstraints(BIZ, { action_type: 'inactive_scope_type' });
    expect(result.allowed).toBe(true);
  });

  test('a constraint outside its starts_at/ends_at window does not apply', () => {
    insertConstraint({
      constraint_type: 'freeze', scope: { action_type: 'future_freeze_type' },
      starts_at: '2099-01-01T00:00:00.000Z',
    });
    const result = checkConstraints(BIZ, { action_type: 'future_freeze_type' });
    expect(result.allowed).toBe(true);
  });

  test('a budget constraint blocks a single action whose declared cost exceeds the limit', () => {
    insertConstraint({ constraint_type: 'budget', scope: { action_type: 'expensive_campaign' }, limit_value: 500, limit_unit: 'gbp' });
    const overBudget = checkConstraints(BIZ, { action_type: 'expensive_campaign', estimated_cost: 900 });
    expect(overBudget.allowed).toBe(false);

    const underBudget = checkConstraints(BIZ, { action_type: 'expensive_campaign', estimated_cost: 100 });
    expect(underBudget.allowed).toBe(true);
  });

  test('an hours constraint blocks outside the configured window', () => {
    insertConstraint({ constraint_type: 'hours', scope: { action_type: 'business_hours_only', start_hour: 9, end_hour: 17 } });
    const outsideHours = checkConstraints(BIZ, { action_type: 'business_hours_only', at: new Date('2026-01-01T03:00:00.000Z') });
    expect(outsideHours.allowed).toBe(false);

    const insideHours = checkConstraints(BIZ, { action_type: 'business_hours_only', at: new Date('2026-01-01T12:00:00.000Z') });
    expect(insideHours.allowed).toBe(true);
  });

  test('an unscoped constraint applies to everything', () => {
    insertConstraint({ constraint_type: 'manual', scope: {}, note: 'Global pause' });
    const result = checkConstraints(BIZ, { action_type: 'anything_at_all' });
    expect(result.allowed).toBe(false);
  });
});

describe('listConstraints', () => {
  test('activeOnly=true excludes inactive rows', () => {
    const activeId = insertConstraint({ constraint_type: 'manual' });
    insertConstraint({ constraint_type: 'manual', active: false });
    const active = listConstraints(BIZ, true);
    expect(active.some((c) => c.id === activeId)).toBe(true);
    expect(active.every((c) => c.active === 1)).toBe(true);
  });
});
