/**
 * DB-backed tests for the agent lifecycle state machine + matcher guardrails.
 * Uses the in-memory DB forced by test-setup.ts (DATABASE_PATH=:memory:).
 */
import { test, expect, describe, beforeEach } from 'bun:test';
import db from '../db/db.js';
import {
  VALID_AGENT_TRANSITIONS,
  canTransition,
  transitionAgent,
  setLifecycleState,
  getLifecycleState,
  isInCooldown,
  computeCooldownUntil,
  blockAgent,
  recordAgentSuccess,
  lifecycleToLegacyStatus,
} from './agentLifecycle.js';
import {
  matchAgent,
  claimTaskOwnership,
  isScopeInFlight,
  deriveRequirements,
  countBusyAgents,
} from './agentMatcher.js';

const BIZ = 'biz-lifecycle-test';

function seedAgent(id: string, lifecycle: string, status = 'active'): void {
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, lifecycle_state, kb_scope, data_sources_allowed, task_types_allowed, success_count, failure_count)
    VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 0, 0)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, lifecycle_state=excluded.lifecycle_state
  `).run(id, `server/agents/${id}/profile.yaml`, id, status, lifecycle);
}

function ensureBusiness(): void {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'LC Test', 'lc-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
}

function resetDb(): void {
  db.prepare('DELETE FROM outcome_measurement_runs').run();
  db.prepare('DELETE FROM task_events').run();
  db.prepare('DELETE FROM execution_jobs').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM agent_runs').run();
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM agent_lifecycle_events').run();
  db.prepare('DELETE FROM agent_activations').run();
  ensureBusiness();
}

describe('VALID_AGENT_TRANSITIONS â€” invariants', () => {
  test('hired only goes to standby or archived (never straight to working)', () => {
    expect(VALID_AGENT_TRANSITIONS.hired).toContain('standby');
    expect(VALID_AGENT_TRANSITIONS.hired).not.toContain('working');
  });
  test('standby cannot jump straight to working (must be triggered first)', () => {
    expect(canTransition('standby', 'working')).toBe(false);
    expect(canTransition('standby', 'triggered')).toBe(true);
  });
  test('proposed requires approval before hired', () => {
    expect(canTransition('proposed', 'hired')).toBe(false);
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('approved', 'hired')).toBe(true);
  });
  test('blocked never loops directly back to working', () => {
    expect(canTransition('blocked', 'working')).toBe(false);
    expect(VALID_AGENT_TRANSITIONS.blocked).toContain('standby');
  });
  test('archived is terminal', () => {
    expect(VALID_AGENT_TRANSITIONS.archived).toEqual([]);
  });
});

describe('lifecycleToLegacyStatus bridge', () => {
  test('pre-hire states map to pending', () => {
    expect(lifecycleToLegacyStatus('candidate')).toBe('pending');
    expect(lifecycleToLegacyStatus('proposed')).toBe('pending');
  });
  test('working roster maps to active', () => {
    expect(lifecycleToLegacyStatus('standby')).toBe('active');
    expect(lifecycleToLegacyStatus('working')).toBe('active');
  });
  test('blocked maps to paused (conductor will not run it)', () => {
    expect(lifecycleToLegacyStatus('blocked')).toBe('paused');
  });
  test('archived maps to retired', () => {
    expect(lifecycleToLegacyStatus('archived')).toBe('retired');
  });
});

describe('transitionAgent â€” enforcement', () => {
  beforeEach(resetDb);

  test('legal transition succeeds and records an event', () => {
    seedAgent('merchant', 'standby');
    const res = transitionAgent('merchant', 'triggered', 'test', { businessId: BIZ, reason: 'signal matched' });
    expect(res.ok).toBe(true);
    expect(getLifecycleState('merchant')).toBe('triggered');
    const ev = db.prepare("SELECT * FROM agent_lifecycle_events WHERE agent_id = 'merchant' ORDER BY created_at DESC LIMIT 1").get() as { to_state: string } | undefined;
    expect(ev?.to_state).toBe('triggered');
  });

  test('illegal transition throws', () => {
    seedAgent('merchant', 'standby');
    expect(() => transitionAgent('merchant', 'working', 'test')).toThrow(/Illegal agent transition/);
    // state unchanged
    expect(getLifecycleState('merchant')).toBe('standby');
  });

  test('legacy status column stays in sync via the bridge', () => {
    seedAgent('merchant', 'standby');
    transitionAgent('merchant', 'archived', 'test');
    const row = db.prepare("SELECT status, lifecycle_state FROM agents WHERE id = 'merchant'").get() as { status: string; lifecycle_state: string };
    expect(row.lifecycle_state).toBe('archived');
    expect(row.status).toBe('retired');
  });
});

describe('cooldown â€” blocked agents do not retry endlessly', () => {
  beforeEach(resetDb);

  test('computeCooldownUntil grows with failures and is in the future', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = new Date(computeCooldownUntil(1, now)).getTime();
    const third = new Date(computeCooldownUntil(3, now)).getTime();
    expect(first).toBeGreaterThan(now.getTime());
    expect(third).toBeGreaterThan(first);
  });

  test('blockAgent sets cooldown and increments failure_count', () => {
    seedAgent('merchant', 'working');
    const res = blockAgent('merchant', 'test', 'run failed', { businessId: BIZ });
    expect(res.ok).toBe(true);
    expect(getLifecycleState('merchant')).toBe('blocked');
    expect(isInCooldown('merchant')).toBe(true);
    const row = db.prepare("SELECT failure_count FROM agents WHERE id = 'merchant'").get() as { failure_count: number };
    expect(row.failure_count).toBe(1);
  });

  test('recordAgentSuccess clears cooldown and increments success_count', () => {
    seedAgent('merchant', 'working');
    blockAgent('merchant', 'test', 'fail', { businessId: BIZ });
    // move blocked -> standby (legal) then succeed
    transitionAgent('merchant', 'standby', 'test');
    recordAgentSuccess('merchant');
    expect(isInCooldown('merchant')).toBe(false);
    const row = db.prepare("SELECT success_count, cooldown_until FROM agents WHERE id = 'merchant'").get() as { success_count: number; cooldown_until: string | null };
    expect(row.success_count).toBe(1);
    expect(row.cooldown_until).toBeNull();
  });
});

describe('matchAgent (DB-backed) â€” best-match + manual routing', () => {
  beforeEach(() => {
    resetDb();
    // Seed two live specialists with real scopes via setLifecycleState +
    // direct scope columns so matchAgent can score them.
    seedAgent('seo-sentinel', 'standby');
    seedAgent('merchant', 'standby');
    db.prepare("UPDATE agents SET kb_scope=?, data_sources_allowed=?, task_types_allowed=? WHERE id='seo-sentinel'")
      .run(JSON.stringify(['gsc', 'indexing', 'ranking', 'content', 'metadata']), JSON.stringify(['gsc']), JSON.stringify(['meta_update']));
    db.prepare("UPDATE agents SET kb_scope=?, data_sources_allowed=?, task_types_allowed=? WHERE id='merchant'")
      .run(JSON.stringify(['shopify', 'product', 'conversion']), JSON.stringify(['shopify']), JSON.stringify(['shopify_product_update']));
  });

  test('a GSC signal routes to seo-sentinel, with merchant as a non-match', () => {
    const m = matchAgent({ connector_type: 'gsc', rule_id: 'gsc:ranking_drop', action_type: 'meta_update' }, BIZ);
    expect(m.best?.agent_id).toBe('seo-sentinel');
    expect(m.should_be_manual).toBe(false);
    expect(m.assignment_reason.toLowerCase()).toContain('gsc');
  });

  test('a signal in nobody\'s scope routes to a human', () => {
    const m = matchAgent({ connector_type: 'stripe', rule_id: 'stripe:refund_spike' }, BIZ);
    expect(m.best).toBeNull();
    expect(m.should_be_manual).toBe(true);
    expect(m.manual_reason).toBeTruthy();
  });

  test('an agent in cooldown is skipped by the matcher', () => {
    // Put seo-sentinel in cooldown; the GSC signal should then find no agent.
    setLifecycleState('seo-sentinel', 'standby', 'test', { patch: { cooldown_until: computeCooldownUntil(2) } });
    const m = matchAgent({ connector_type: 'gsc', rule_id: 'gsc:ranking_drop', action_type: 'meta_update' }, BIZ);
    expect(m.best).toBeNull();
  });
});

describe('claimTaskOwnership â€” exactly one active owner', () => {
  beforeEach(resetDb);

  test('first claim wins, second claim by another agent is refused', () => {
    db.prepare(`
      INSERT INTO tasks (id, business_id, title, proposed_by, status, action_payload, created_at, updated_at)
      VALUES ('t1', ?, 'Fix metadata', 'seo-sentinel', 'approved', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(BIZ);
    expect(claimTaskOwnership('t1', 'seo-sentinel')).toBe(true);
    expect(claimTaskOwnership('t1', 'merchant')).toBe(false);
    // idempotent re-claim by the owner still succeeds
    expect(claimTaskOwnership('t1', 'seo-sentinel')).toBe(true);
    const row = db.prepare("SELECT assigned_to FROM tasks WHERE id='t1'").get() as { assigned_to: string };
    expect(row.assigned_to).toBe('seo-sentinel');
  });
});

describe('isScopeInFlight â€” no duplicate agent for the same scope', () => {
  beforeEach(() => {
    resetDb();
    seedAgent('merchant', 'working'); // busy on shopify scope
    db.prepare("UPDATE agents SET kb_scope=? WHERE id='merchant'").run(JSON.stringify(['shopify', 'product']));
  });

  test('a second shopify trigger detects the in-flight scope', () => {
    const req = deriveRequirements({ connector_type: 'shopify', rule_id: 'shopify:low_stock' });
    expect(isScopeInFlight(req, BIZ, 'someone-else')).toBe(true);
  });

  test('an open assigned task of the same action_type counts as in-flight', () => {
    db.prepare('DELETE FROM agents').run(); // remove busy agent so only the task triggers it
    db.prepare(`
      INSERT INTO tasks (id, business_id, title, proposed_by, assigned_to, action_type, status, action_payload, created_at, updated_at)
      VALUES ('t2', ?, 'Update product', 'merchant', 'merchant', 'shopify_product_update', 'executing', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(BIZ);
    const req = deriveRequirements({ connector_type: 'shopify', action_type: 'shopify_product_update' });
    expect(isScopeInFlight(req, BIZ)).toBe(true);
  });
});

describe('countBusyAgents â€” max-active cap input', () => {
  beforeEach(resetDb);
  test('counts only busy lifecycle states', () => {
    seedAgent('a1', 'working');
    seedAgent('a2', 'standby');
    seedAgent('a3', 'awaiting_approval');
    expect(countBusyAgents()).toBe(2);
  });
});
