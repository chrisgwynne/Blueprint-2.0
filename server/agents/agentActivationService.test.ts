/**
 * Tests for the activation service: it must NOT run work on hire, must record
 * an activation + drive the lifecycle, require evidence before counting a
 * completion as a success, and block+cooldown on failure. Hermetic: the runner
 * is injected, so no LLM/network is touched.
 */
import { test, expect, describe, beforeEach } from 'bun:test';
import db from '../db/db.js';
import { runWithActivation } from './agentActivationService.js';
import { getLifecycleState, isInCooldown, setLifecycleState } from './agentLifecycle.js';

const BIZ = 'biz-activation-test';

function seedStandby(id: string): void {
  db.prepare(`
    INSERT INTO agents (id, profile_path, name, status, lifecycle_state, kb_scope, data_sources_allowed, task_types_allowed, success_count, failure_count)
    VALUES (?, ?, ?, 'active', 'standby', '[]', '[]', '[]', 0, 0)
    ON CONFLICT(id) DO UPDATE SET status='active', lifecycle_state='standby', success_count=0, failure_count=0, cooldown_until=NULL
  `).run(id, `server/agents/${id}/profile.yaml`, id);
}

function reset(): void {
  db.prepare('DELETE FROM agent_runs').run();
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM agent_activations').run();
  db.prepare('DELETE FROM agent_lifecycle_events').run();
}

describe('runWithActivation', () => {
  beforeEach(reset);

  test('records an activation row with the selection reason + matched areas', async () => {
    seedStandby('merchant');
    let called = false;
    await runWithActivation({
      agentId: 'merchant', businessId: BIZ, channel: 'signal', trigger: 'signal',
      triggerRef: 'sig1', matchedAreas: ['shopify', 'product'],
      selectionReason: 'Signal matched shopify, product.',
      confidence: 0.8, evidence: [{ type: 'signal', id: 'sig1' }],
      runner: async () => { called = true; return { runId: 'run1', skipped: false, tasksProposed: 1, signalsDetected: 0 }; },
    });
    expect(called).toBe(true);
    const act = db.prepare("SELECT * FROM agent_activations WHERE agent_id='merchant'").get() as { selection_reason: string; matched_areas: string; run_id: string; confidence: number } | undefined;
    expect(act?.selection_reason).toContain('shopify');
    expect(act?.run_id).toBe('run1');
    expect(JSON.parse(act!.matched_areas)).toContain('product');
  });

  test('a productive run WITH evidence ends in standby and counts as success', async () => {
    seedStandby('merchant');
    await runWithActivation({
      agentId: 'merchant', businessId: BIZ, channel: 'signal', trigger: 'signal',
      matchedAreas: ['shopify'], selectionReason: 'x',
      evidence: [{ type: 'signal', id: 's' }],
      runner: async () => ({ runId: 'r', skipped: false, tasksProposed: 2 }),
    });
    expect(getLifecycleState('merchant')).toBe('standby');
    const row = db.prepare("SELECT success_count FROM agents WHERE id='merchant'").get() as { success_count: number };
    expect(row.success_count).toBe(1);
  });

  test('a skipped run returns to standby without counting success or failure', async () => {
    seedStandby('merchant');
    await runWithActivation({
      agentId: 'merchant', businessId: BIZ, channel: 'signal', trigger: 'signal',
      matchedAreas: ['shopify'], selectionReason: 'x', evidence: [],
      runner: async () => ({ runId: 'r', skipped: true }),
    });
    expect(getLifecycleState('merchant')).toBe('standby');
    const row = db.prepare("SELECT success_count, failure_count FROM agents WHERE id='merchant'").get() as { success_count: number; failure_count: number };
    expect(row.success_count).toBe(0);
    expect(row.failure_count).toBe(0);
  });

  test('a failing run blocks the agent and sets a cooldown (no endless retry)', async () => {
    seedStandby('merchant');
    let threw = false;
    try {
      await runWithActivation({
        agentId: 'merchant', businessId: BIZ, channel: 'signal', trigger: 'signal',
        matchedAreas: ['shopify'], selectionReason: 'x', evidence: [],
        runner: async () => { throw new Error('LLM exploded'); },
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
    expect(getLifecycleState('merchant')).toBe('blocked');
    expect(isInCooldown('merchant')).toBe(true);
  });

  test('the lifecycle passes through triggered â†’ working during the run', async () => {
    seedStandby('merchant');
    const statesSeen: (string | null)[] = [];
    await runWithActivation({
      agentId: 'merchant', businessId: BIZ, channel: 'signal', trigger: 'signal',
      matchedAreas: ['shopify'], selectionReason: 'x', evidence: [{ type: 'signal' }],
      runner: async () => { statesSeen.push(getLifecycleState('merchant')); return { runId: 'r', tasksProposed: 1 }; },
    });
    expect(statesSeen[0]).toBe('working'); // agent is 'working' while the runner executes
  });
});
