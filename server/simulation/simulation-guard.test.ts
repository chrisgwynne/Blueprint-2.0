/**
 * The simulation side-effect guard (issue #67).
 *
 * The acceptance criterion is "Regression tests prove side-effect
 * suppression across every supported trigger path" — and, crucially,
 * "Enforce safeguards in shared execution paths, not only in the UI".
 *
 * This file tests the ENFORCEMENT MECHANISM itself, at the shared paths:
 * that a write blocked inside a simulation is blocked because db.prepare()
 * and the named side-effecting entry points refuse it, not because the
 * caller was polite. simulation.test.ts then proves the property holds for
 * each of the five supported preview kinds.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../db/db.js';
import {
  runInSimulationScope, newSimulationScope, allowSimulationWrite,
  guardSimulationSideEffect, currentSimulationScope, isSimulating,
  simulationScopesActive, isWriteStatement, sqlWriteTarget,
  SimulationSideEffectError,
} from './simulation-context.js';
import { createTask, approveTask } from '../tasks/task-queue.js';
import { enqueueExecutionJob } from '../tasks/execution-jobs.js';
import { installAgent } from '../agents/installer.js';
import { dispatchWebhookEvent } from '../bap/webhook-dispatcher.js';
import { dispatch } from '../notifications/dispatcher.js';
import { dispatchAgentEvent } from '../agents/event-triggers.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { upsertActionRegistryEntry } from '../tasks/action-registry.js';

const BIZ = 'biz_sim_guard';
const ACTION = 'test_sim_guard_action';

function inSimulation<T>(fn: () => T): T {
  return runInSimulationScope(newSimulationScope({ kind: 'test', businessId: BIZ, actor: 'test:guard' }), fn);
}

beforeAll(() => {
  db.prepare("INSERT INTO businesses (id, name, slug) VALUES (?, 'Guard Biz', 'guard-biz') ON CONFLICT(id) DO NOTHING").run(BIZ);
  upsertActionRegistryEntry(ACTION, {
    description: 'Guard fixture action.',
    payload_schema: { type: 'object', properties: {} },
    dispatched_by_executor: true,
    side_effect_classification: 'internal_idempotent',
    risk_level: 'low',
    requires_approval: false,
  });
});

// ─── The database chokepoint ────────────────────────────────────────────────

describe('the database itself refuses writes inside a simulation', () => {
  test('INSERT, UPDATE, DELETE and REPLACE all throw', () => {
    for (const sql of [
      "INSERT INTO settings (key, value) VALUES ('x', 'y')",
      "UPDATE tasks SET title = 'x' WHERE id = 'nope'",
      "DELETE FROM tasks WHERE id = 'nope'",
      "REPLACE INTO settings (key, value) VALUES ('x', 'y')",
    ]) {
      expect(() => inSimulation(() => db.prepare(sql).run())).toThrow(SimulationSideEffectError);
    }
  });

  test('a write hidden behind a CTE is caught too', () => {
    // The obvious way to slip a write past a naive "starts with SELECT" check.
    expect(() => inSimulation(() =>
      db.prepare("WITH doomed AS (SELECT id FROM tasks) DELETE FROM tasks WHERE id IN (SELECT id FROM doomed)").run(),
    )).toThrow(SimulationSideEffectError);
  });

  test('reads are completely unaffected', () => {
    const count = inSimulation(() =>
      (db.prepare('SELECT COUNT(*) AS n FROM businesses').get() as { n: number }).n);
    expect(count).toBeGreaterThan(0);
  });

  test('the blocked write is recorded on the scope, naming the table', () => {
    const scope = newSimulationScope({ kind: 'test', businessId: BIZ, actor: 'test:guard' });
    expect(() => runInSimulationScope(scope, () =>
      db.prepare("UPDATE tasks SET title = 'x' WHERE id = 'nope'").run())).toThrow();
    expect(scope.blocked).toHaveLength(1);
    expect(scope.blocked[0]!.operation).toBe('db.write');
    expect(scope.blocked[0]!.target).toBe('tasks');
    expect(scope.blocked[0]!.detail).toContain('UPDATE');
  });

  test('the guard is off outside a simulation — normal writes are untouched', () => {
    expect(simulationScopesActive()).toBe(false);
    expect(isSimulating()).toBe(false);
    db.prepare("INSERT INTO settings (key, value) VALUES ('sim_guard_probe', '1') ON CONFLICT(key) DO NOTHING").run();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sim_guard_probe'").get() as { value: unknown };
    expect(String(row.value)).toBe('1');
    db.prepare("DELETE FROM settings WHERE key = 'sim_guard_probe'").run();
  });

  test('SQL classification recognises writes and their target table', () => {
    expect(isWriteStatement('SELECT * FROM tasks')).toBe(false);
    expect(isWriteStatement('  insert into tasks (id) values (?)')).toBe(true);
    expect(sqlWriteTarget('INSERT OR IGNORE INTO notifications (id) VALUES (?)')).toBe('notifications');
    expect(sqlWriteTarget('UPDATE  operating_policies SET state = ?')).toBe('operating_policies');
    expect(sqlWriteTarget('DELETE FROM execution_jobs WHERE id = ?')).toBe('execution_jobs');
  });
});

// ─── The named side-effecting entry points ──────────────────────────────────

describe('the shared side-effecting entry points refuse to act inside a simulation', () => {
  test('creating a task is blocked', () => {
    expect(() => inSimulation(() => createTask({
      business_id: BIZ, title: 'Should never exist', proposed_by: 'test:guard',
      action_type: ACTION, action_payload: {},
    }))).toThrow(SimulationSideEffectError);
  });

  test('approving a task is blocked', () => {
    expect(() => inSimulation(() => approveTask('any_task_id', 'test:guard')))
      .toThrow(SimulationSideEffectError);
  });

  test('enqueueing an execution job is blocked', () => {
    expect(() => inSimulation(() => enqueueExecutionJob({
      id: 't1', business_id: BIZ, version: 1, action_type: ACTION,
    } as Parameters<typeof enqueueExecutionJob>[0]))).toThrow(SimulationSideEffectError);
  });

  test('installing (hiring) an agent is blocked', () => {
    expect(() => inSimulation(() => installAgent('any-template', BIZ, 'test:guard')))
      .toThrow(SimulationSideEffectError);
  });

  test('dispatching a BAP webhook is blocked', () => {
    expect(() => inSimulation(() => dispatchWebhookEvent('task.approved', { task_id: 'x' })))
      .toThrow(SimulationSideEffectError);
  });

  test('sending a notification is blocked', async () => {
    await expect(inSimulation(() => dispatch({
      business_id: BIZ, channel: 'telegram', severity: 'info', title: 'nope', body: 'nope',
    } as Parameters<typeof dispatch>[0]))).rejects.toThrow(SimulationSideEffectError);
  });

  test('dispatching an agent event is blocked', async () => {
    await expect(inSimulation(() => dispatchAgentEvent('task.approved', {}, BIZ)))
      .rejects.toThrow(SimulationSideEffectError);
  });

  test('any outbound HTTP request is blocked', async () => {
    // The single chokepoint every connector mutation and provider call in
    // Blueprint goes through — this is what makes "no external writes" true
    // in general rather than for the paths someone remembered to check.
    await expect(inSimulation(() => safeFetch('https://api.example.com/orders', { method: 'POST' })))
      .rejects.toThrow(SimulationSideEffectError);
  });

  test('a blocked entry point names what it stopped, for the operator', () => {
    const scope = newSimulationScope({ kind: 'test', businessId: BIZ, actor: 'test:guard' });
    expect(() => runInSimulationScope(scope, () => createTask({
      business_id: BIZ, title: 'Named', proposed_by: 'test:guard',
    }))).toThrow();
    expect(scope.blocked[0]!.operation).toBe('task.create');
    expect(scope.blocked[0]!.detail).toContain('Named');
  });

  test('none of the blocked calls left a row behind', () => {
    const tasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE business_id = ?').get(BIZ) as { n: number }).n;
    const jobs = (db.prepare('SELECT COUNT(*) AS n FROM execution_jobs WHERE business_id = ?').get(BIZ) as { n: number }).n;
    const notes = (db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE business_id = ?').get(BIZ) as { n: number }).n;
    expect({ tasks, jobs, notes }).toEqual({ tasks: 0, jobs: 0, notes: 0 });
  });
});

// ─── Scope semantics ────────────────────────────────────────────────────────

describe('scope semantics', () => {
  test('the guard disarms once the scope exits', () => {
    inSimulation(() => undefined);
    expect(simulationScopesActive()).toBe(false);
    // A real write now succeeds, proving the scope was released rather than leaked.
    db.prepare("INSERT INTO settings (key, value) VALUES ('sim_scope_probe', '1') ON CONFLICT(key) DO NOTHING").run();
    db.prepare("DELETE FROM settings WHERE key = 'sim_scope_probe'").run();
  });

  test('the guard stays armed across await boundaries in an async evaluator', async () => {
    // Releasing the scope when the synchronous prefix returned would disarm
    // the guard for the whole of an awaited evaluator — the exact bug this
    // asserts against.
    await expect(inSimulation(async () => {
      await Promise.resolve();
      return db.prepare("UPDATE tasks SET title = 'x' WHERE id = 'nope'").run();
    })).rejects.toThrow(SimulationSideEffectError);
    expect(simulationScopesActive()).toBe(false);
  });

  test('the scope is released even when the evaluator throws', () => {
    expect(() => inSimulation(() => { throw new Error('evaluator exploded'); })).toThrow('evaluator exploded');
    expect(simulationScopesActive()).toBe(false);
  });

  test('code outside the scope is unaffected while a simulation is live', () => {
    // liveScopes is only a fast-path hint; the AsyncLocalStorage store is
    // the authority, so a concurrent real request must not be blocked.
    inSimulation(() => {
      expect(currentSimulationScope()).toBeDefined();
    });
    expect(currentSimulationScope()).toBeUndefined();
  });
});

// ─── The narrow escape hatch ────────────────────────────────────────────────

describe('allowSimulationWrite discloses rather than hides', () => {
  test('a permitted write proceeds and is RECORDED as neutral with its reason', () => {
    const scope = newSimulationScope({ kind: 'test', businessId: BIZ, actor: 'test:guard' });
    runInSimulationScope(scope, () => {
      allowSimulationWrite('a documented housekeeping write', () => {
        db.prepare("INSERT INTO settings (key, value) VALUES ('sim_neutral_probe', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      });
    });

    expect(scope.blocked).toEqual([]);
    expect(scope.neutral_writes).toHaveLength(1);
    expect(scope.neutral_writes[0]!.reason).toBe('a documented housekeeping write');
    expect(scope.neutral_writes[0]!.target).toBe('settings');
    db.prepare("DELETE FROM settings WHERE key = 'sim_neutral_probe'").run();
  });

  test('the permit ends with the block — writes after it are blocked again', () => {
    expect(() => inSimulation(() => {
      allowSimulationWrite('brief', () => undefined);
      db.prepare("UPDATE tasks SET title = 'x' WHERE id = 'nope'").run();
    })).toThrow(SimulationSideEffectError);
  });

  test('a permit does NOT unlock the named entry points', () => {
    // Creating a task, hiring an agent or calling out to the internet has no
    // legitimate "simulation-neutral" form, so the permit deliberately does
    // not reach them.
    expect(() => inSimulation(() => allowSimulationWrite('trying it on', () => createTask({
      business_id: BIZ, title: 'Still blocked', proposed_by: 'test:guard',
    })))).toThrow(SimulationSideEffectError);
  });

  test('outside a simulation it is a transparent pass-through', () => {
    const value = allowSimulationWrite('no scope', () => 42);
    expect(value).toBe(42);
  });
});

// ─── Structural guards ──────────────────────────────────────────────────────

describe('structural: the guard cannot itself become the thing that needs guarding', () => {
  test('simulation-context.ts imports nothing but async_hooks and crypto', async () => {
    const source = await Bun.file(new URL('./simulation-context.ts', import.meta.url)).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.sort()).toEqual(['node:async_hooks', 'node:crypto']);
  });

  test('guardSimulationSideEffect is a no-op outside a simulation', () => {
    expect(() => guardSimulationSideEffect('test.op', 'target', 'detail')).not.toThrow();
  });
});
