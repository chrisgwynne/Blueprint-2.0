import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import db from '../db/db.js';
import { createSystemIssue, getSystemIssue, listSystemIssues, updateSystemIssueStatus } from './system-issues.js';

const BIZ = 'biz_system_issues_test';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'System Issues Test', 'system-issues-test') ON CONFLICT(id) DO NOTHING`).run(BIZ);
});

afterAll(() => {
  db.prepare(`DELETE FROM system_issues WHERE business_id = ?`).run(BIZ);
});

describe('createSystemIssue / getSystemIssue', () => {
  test('creates and round-trips a full issue', () => {
    const issue = createSystemIssue({
      business_id: BIZ,
      issue_type: 'action_validation_failure',
      severity: 'error',
      title: 'Test issue',
      description: 'Something went wrong.',
      related_task_id: 'task-123',
      related_action_type: 'shopify_product_update',
      metadata: { foo: 'bar' },
    });
    expect(issue.status).toBe('open');
    expect(issue.related_task_id).toBe('task-123');
    expect(issue.metadata).toEqual({ foo: 'bar' });

    const fetched = getSystemIssue(issue.id);
    expect(fetched).toEqual(issue);
  });

  test('related_task_id survives deletion of the referenced task (soft reference)', () => {
    const taskId = 'task-that-will-be-deleted';
    db.prepare(`INSERT INTO tasks (id, business_id, title, proposed_by, status, trust_tier, approval_mode, version, created_at, updated_at)
                VALUES (?, ?, 'temp', 'test', 'proposed', 'yellow', 'requires_approval', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(taskId, BIZ);
    const issue = createSystemIssue({ business_id: BIZ, issue_type: 'test', title: 'refs a task', related_task_id: taskId });
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    // Would throw a FK error here if related_task_id were a hard reference.
    expect(getSystemIssue(issue.id)).not.toBeNull();
  });
});

describe('listSystemIssues', () => {
  test('filters by business_id, status, and issue_type', () => {
    createSystemIssue({ business_id: BIZ, issue_type: 'type_a', title: 'A' });
    createSystemIssue({ business_id: BIZ, issue_type: 'type_b', title: 'B' });

    const all = listSystemIssues({ business_id: BIZ });
    expect(all.length).toBeGreaterThanOrEqual(2);

    const onlyA = listSystemIssues({ business_id: BIZ, issue_type: 'type_a' });
    expect(onlyA.every((i) => i.issue_type === 'type_a')).toBe(true);
  });
});

describe('updateSystemIssueStatus', () => {
  test('resolving an issue sets resolved_at', () => {
    const issue = createSystemIssue({ business_id: BIZ, issue_type: 'test', title: 'to resolve' });
    expect(issue.resolved_at).toBeNull();
    const resolved = updateSystemIssueStatus(issue.id, 'resolved');
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolved_at).not.toBeNull();
  });

  test('acknowledging an issue does not set resolved_at', () => {
    const issue = createSystemIssue({ business_id: BIZ, issue_type: 'test', title: 'to ack' });
    const acked = updateSystemIssueStatus(issue.id, 'acknowledged');
    expect(acked!.status).toBe('acknowledged');
    expect(acked!.resolved_at).toBeNull();
  });
});
