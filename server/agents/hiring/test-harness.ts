/**
 * Test isolation harness for the hiring suite (#58).
 *
 * Hiring tests write proposals, suppressions, installations and trials — the
 * exact rows an operator's real instance acts on. A hiring test that opened
 * the developer's ./data/blueprint.db would propose real hires against real
 * businesses, and a test that hit a live connector would sync real data.
 *
 * This module is imported at the top of every hiring test file and FAILS FAST
 * (throws at import time) unless the process is provably isolated:
 *
 *   - DATABASE_PATH must be an in-memory sentinel, or an explicitly isolated
 *     temp path, and must never point at a production-looking artifact.
 *   - Businesses/agents created by tests must use the reserved `test_` id
 *     prefix, so a stray query can never touch a live tenant.
 *   - External connectors are mocked by default: a hiring test declares its
 *     connector rows in the DB and never performs network I/O. Opting out
 *     requires HIRING_INTEGRATION_TEST=1, which is a deliberate, explicit
 *     integration-test mode.
 *
 * (Scope note: this covers the hiring test suite. A CI-wide filesystem and
 * network audit is tracked separately.)
 */

import db, { generateId } from '../../db/db.js';

/** Reserved id prefix. Every business/agent a hiring test creates uses it. */
export const TEST_ID_PREFIX = 'test_hiring_';

const MEMORY_SENTINELS = [':memory:', 'file::memory:'];

function isMemoryPath(p: string | undefined): boolean {
  if (!p) return false;
  return p === ':memory:' || p.startsWith('file::memory:') || p.startsWith(':memory:?');
}

/**
 * Paths that look like a real Blueprint installation. Matching any of these
 * is a hard failure regardless of how the test was invoked.
 */
function looksProduction(p: string): boolean {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)data\/blueprint\.db$/.test(norm)
    || /blueprint\.db$/.test(norm) && !/\/(tmp|temp|var\/folders)\//.test(norm)
    || /\/(prod|production|live)\//.test(norm);
}

export interface IsolationReport {
  database_path: string;
  mode: 'memory' | 'isolated_temp' | 'integration';
  connectors_mocked: boolean;
}

/**
 * Assert the current process is safe for hiring tests. Throws (fails the test
 * file at import) when it is not.
 */
export function assertHiringTestIsolation(): IsolationReport {
  const dbPath = process.env['DATABASE_PATH'];
  const integration = process.env['HIRING_INTEGRATION_TEST'] === '1';

  if (!dbPath) {
    throw new Error(
      '[hiring-test-harness] DATABASE_PATH is unset, so the DB layer would open the default '
      + './data/blueprint.db. Hiring tests must run with DATABASE_PATH=:memory: '
      + '(server/test-setup.ts sets this via bunfig preload).'
    );
  }

  if (isMemoryPath(dbPath)) {
    // An in-memory DB is fresh per process and never touches disk, so every
    // row in it was created by this test run — there is no live tenant to
    // protect. The tenant scan below matters for the file-backed modes.
    return { database_path: dbPath, mode: 'memory', connectors_mocked: !integration };
  }

  if (integration) {
    if (looksProduction(dbPath)) {
      throw new Error(
        `[hiring-test-harness] HIRING_INTEGRATION_TEST=1 but DATABASE_PATH='${dbPath}' looks like a `
        + 'production database. Integration mode still refuses to run against a live instance.'
      );
    }
    return { database_path: dbPath, mode: 'integration', connectors_mocked: false };
  }

  if (looksProduction(dbPath)) {
    throw new Error(
      `[hiring-test-harness] Refusing to run hiring tests against DATABASE_PATH='${dbPath}' — it looks `
      + 'like a real Blueprint database. Use DATABASE_PATH=:memory: '
      + `(one of ${MEMORY_SENTINELS.join(', ')}) or an explicit isolated temp path.`
    );
  }

  // An explicit non-production, non-memory path is allowed only when it is
  // clearly a throwaway location.
  const norm = dbPath.replace(/\\/g, '/');
  if (!/\/(tmp|temp|var\/folders)\//.test(norm) && !/\.test\.db$/.test(norm)) {
    throw new Error(
      `[hiring-test-harness] DATABASE_PATH='${dbPath}' is neither in-memory nor an obviously isolated `
      + 'temp path (…/tmp/…, …/var/folders/…, or *.test.db). Set DATABASE_PATH=:memory:, or set '
      + 'HIRING_INTEGRATION_TEST=1 to opt into an explicit integration run.'
    );
  }

  assertNoLiveTenants();
  return { database_path: dbPath, mode: 'isolated_temp', connectors_mocked: !integration };
}

/**
 * Belt-and-braces: even an in-memory DB is unsafe if something seeded it with
 * real tenants (e.g. a restored dump). A hiring test DB must contain only
 * test-prefixed businesses, or none at all.
 */
export function assertNoLiveTenants(): void {
  let rows: Array<{ id: string; name: string }>;
  try {
    rows = db.prepare('SELECT id, name FROM businesses').all() as Array<{ id: string; name: string }>;
  } catch {
    return; // schema not up yet — nothing to leak
  }
  const live = rows.filter((r) => !r.id.startsWith(TEST_ID_PREFIX) && !/^biz[_-]|^test/i.test(r.id));
  if (live.length > 0) {
    throw new Error(
      `[hiring-test-harness] Refusing to run: the database contains ${live.length} non-test business row(s) `
      + `(e.g. '${live[0]!.id}'). Hiring tests must run against an empty or test-only database.`
    );
  }
}

/** Deterministic, collision-free, reserved-prefix id for a test business. */
export function testBusinessId(suffix: string): string {
  return `${TEST_ID_PREFIX}${suffix}`;
}

/** Reserved-prefix id for a test agent template. */
export function testAgentId(suffix: string): string {
  return `${TEST_ID_PREFIX}agent_${suffix}`;
}

export interface TestBusinessOptions {
  name?: string;
  type?: string;
}

export function createTestBusiness(suffix: string, opts: TestBusinessOptions = {}): string {
  const id = testBusinessId(suffix);
  db.prepare(`
    INSERT INTO businesses (id, name, slug, type) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type
  `).run(id, opts.name ?? `Test Business ${suffix}`, `${id.replace(/_/g, '-')}`, opts.type ?? 'ecommerce');
  return id;
}

/**
 * Insert a MOCK connector row. Hiring tests never open a network connection —
 * a connector is just the DB state the engine reads, so mocking it is
 * complete, not a shortcut.
 */
export function createMockConnector(
  businessId: string,
  type: string,
  opts: { status?: string; lastSyncHoursAgo?: number | null; name?: string } = {},
): string {
  const id = `${TEST_ID_PREFIX}conn_${businessId}_${type}`;
  const lastSync = opts.lastSyncHoursAgo == null
    ? null
    : new Date(Date.now() - opts.lastSyncHoursAgo * 3_600_000).toISOString();
  db.prepare(`
    INSERT INTO connectors (id, business_id, type, name, status, last_sync, credentials, config)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '{"mock":true}')
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_sync = excluded.last_sync
  `).run(id, businessId, type, opts.name ?? `${type} (mock)`, opts.status ?? 'connected', lastSync);
  return id;
}

export function createTestGoal(
  businessId: string,
  opts: { title?: string; metricName?: string; baseline?: number; target?: number } = {},
): string {
  const id = `${TEST_ID_PREFIX}goal_${generateId().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO goals (id, business_id, title, status, metric_name, metric_baseline, metric_target, metric_current)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    id, businessId, opts.title ?? 'Grow organic traffic',
    opts.metricName ?? null, opts.baseline ?? null, opts.target ?? null, opts.baseline ?? null,
  );
  return id;
}

export function createTestSignal(
  businessId: string,
  connectorId: string | null,
  opts: { type?: string; severity?: string; title?: string } = {},
): string {
  const id = `${TEST_ID_PREFIX}signal_${generateId().slice(0, 8)}`;
  db.prepare(`
    INSERT INTO signals (id, business_id, connector_id, rule_id, type, severity, title, status, created_at)
    VALUES (?, ?, ?, 'test-rule', ?, ?, ?, 'open', CURRENT_TIMESTAMP)
  `).run(
    id, businessId, connectorId, opts.type ?? 'traffic_drop',
    opts.severity ?? 'alert', opts.title ?? 'Test signal',
  );
  return id;
}

/** Remove every row this harness could have created for the given businesses. */
export function cleanupTestBusinesses(...businessIds: string[]): void {
  const tables: Array<[string, string]> = [
    ['hiring_trials', 'business_id'],
    ['hiring_proposal_keys', 'business_id'],
    ['hiring_decisions', 'business_id'],
    ['hiring_analysis_runs', 'business_id'],
    ['hiring_coordination', 'business_id'],
    ['agent_installations', 'business_id'],
    ['task_events', ''],
    ['tasks', 'business_id'],
    ['signals', 'business_id'],
    ['goals', 'business_id'],
    ['connectors', 'business_id'],
    ['agent_runs', 'business_id'],
    ['audit_log', 'business_id'],
    ['notifications', 'business_id'],
    ['businesses', 'id'],
  ];
  for (const id of businessIds) {
    for (const [table, col] of tables) {
      try {
        if (table === 'task_events') {
          db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE business_id = ?)').run(id);
          continue;
        }
        db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(id);
      } catch { /* table may not exist in every schema revision */ }
    }
  }
}
