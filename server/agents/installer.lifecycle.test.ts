/**
 * Tests the core complaint fix at the installer level: hiring an agent must NOT
 * auto-activate it. A freshly hired agent lands in `standby` (if ready) or
 * `candidate` (if its connectors aren't ready), and never in a working state.
 *
 * Hermetic: uses the in-memory DB. The installer copies real template files
 * from server/agents/templates/<id> to server/agents/<id>, so we use the
 * 'merchant' template that ships in the repo and clean up the DB row.
 */
import { test, expect, describe, beforeEach } from 'bun:test';
import db from '../db/db.js';
import { installAgent } from './installer.js';
import { getLifecycleState } from './agentLifecycle.js';

const BIZ = 'biz-installer-test';

function ensureBusiness(): void {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Test', 'test-installer') ON CONFLICT(id) DO NOTHING`).run(BIZ);
}

describe('installAgent — no auto-activation on hire', () => {
  beforeEach(() => {
    ensureBusiness();
    db.prepare("DELETE FROM agents WHERE id = 'merchant'").run();
    db.prepare("DELETE FROM agent_lifecycle_events WHERE agent_id = 'merchant'").run();
  });

  test('a hired agent is never placed directly into a working state', () => {
    const result = installAgent('merchant', BIZ, 'test');
    // Merchant requires the shopify connector which is absent in this test DB,
    // so it lands as 'candidate' (waiting). Either way it must be a resting /
    // pre-work state — NEVER triggered/working/assigned.
    expect(['standby', 'candidate']).toContain(result.lifecycle_state);
    expect(getLifecycleState('merchant')).toBe(result.lifecycle_state);
  });

  test('hiring seeds the structured scope from ROLE_SPECS', () => {
    installAgent('merchant', BIZ, 'test');
    const row = db.prepare("SELECT kb_scope, data_sources_allowed, role FROM agents WHERE id='merchant'").get() as { kb_scope: string; data_sources_allowed: string; role: string };
    const scope = JSON.parse(row.kb_scope) as string[];
    expect(scope).toContain('shopify');
    expect(row.role).toBeTruthy();
    expect(JSON.parse(row.data_sources_allowed)).toContain('shopify');
  });

  test('the legacy status column is kept in sync (candidate→pending / standby→active)', () => {
    const result = installAgent('merchant', BIZ, 'test');
    const row = db.prepare("SELECT status FROM agents WHERE id='merchant'").get() as { status: string };
    if (result.lifecycle_state === 'standby') expect(row.status).toBe('active');
    else expect(row.status).toBe('pending');
  });

  test('a lifecycle event is recorded for the hire', () => {
    installAgent('merchant', BIZ, 'test');
    const ev = db.prepare("SELECT to_state FROM agent_lifecycle_events WHERE agent_id='merchant' ORDER BY created_at DESC LIMIT 1").get() as { to_state: string } | undefined;
    expect(ev).toBeDefined();
    expect(['standby', 'candidate']).toContain(ev!.to_state);
  });
});
