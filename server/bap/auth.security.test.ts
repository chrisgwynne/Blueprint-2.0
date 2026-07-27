/**
 * Regression tests for the BAP registration/authorization hardening (F-01,
 * F-03, F-04, F-07).
 *
 * Hermetic: uses the shared in-memory/file DB the test runner configures
 * via DATABASE_PATH, seeding a real business row so filterValidBusinessIds
 * can validate against it.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import db from '../db/db.js';
import {
  isRegistrationAuthorized,
  filterGrantablePermissions,
  filterValidBusinessIds,
  hasPermission,
  GRANTABLE_BAP_PERMISSIONS,
} from './auth.ts';
import type { Request } from 'express';

const BIZ_A = 'biz_auth_test_a';
const BIZ_B = 'biz_auth_test_b';

beforeAll(() => {
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Auth Test A', 'auth-test-a') ON CONFLICT(id) DO NOTHING`).run(BIZ_A);
  db.prepare(`INSERT INTO businesses (id, name, slug) VALUES (?, 'Auth Test B', 'auth-test-b') ON CONFLICT(id) DO NOTHING`).run(BIZ_B);
});

function fakeReq(opts: { session?: Record<string, unknown>; headers?: Record<string, string> } = {}): Request {
  return {
    session: opts.session,
    headers: opts.headers ?? {},
  } as unknown as Request;
}

describe('isRegistrationAuthorized — F-01: no unauthenticated registration', () => {
  test('rejects a request with no session and no secret header', () => {
    const req = fakeReq();
    expect(isRegistrationAuthorized(req)).toBe(false);
  });

  test('rejects a request with an empty session', () => {
    const req = fakeReq({ session: {} });
    expect(isRegistrationAuthorized(req)).toBe(false);
  });

  test('accepts an authenticated dashboard session', () => {
    const req = fakeReq({ session: { userId: 'admin' } });
    expect(isRegistrationAuthorized(req)).toBe(true);
  });

  test('rejects a wrong X-Registration-Secret even when one is configured', () => {
    const prev = process.env.BAP_REGISTRATION_SECRET;
    process.env.BAP_REGISTRATION_SECRET = 'correct-secret-value';
    try {
      const req = fakeReq({ headers: { 'x-registration-secret': 'wrong-guess' } });
      expect(isRegistrationAuthorized(req)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BAP_REGISTRATION_SECRET;
      else process.env.BAP_REGISTRATION_SECRET = prev;
    }
  });

  test('accepts the correct X-Registration-Secret when configured', () => {
    const prev = process.env.BAP_REGISTRATION_SECRET;
    process.env.BAP_REGISTRATION_SECRET = 'correct-secret-value';
    try {
      const req = fakeReq({ headers: { 'x-registration-secret': 'correct-secret-value' } });
      expect(isRegistrationAuthorized(req)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BAP_REGISTRATION_SECRET;
      else process.env.BAP_REGISTRATION_SECRET = prev;
    }
  });

  test('a secret header is never accepted when no secret is configured', () => {
    const prev = process.env.BAP_REGISTRATION_SECRET;
    delete process.env.BAP_REGISTRATION_SECRET;
    try {
      const req = fakeReq({ headers: { 'x-registration-secret': 'anything' } });
      expect(isRegistrationAuthorized(req)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.BAP_REGISTRATION_SECRET = prev;
    }
  });
});

describe('filterGrantablePermissions — no wildcard privilege self-assignment', () => {
  test('strips the global wildcard "*:*"', () => {
    expect(filterGrantablePermissions(['*:*'])).toEqual([]);
  });

  test('strips a resource wildcard like "tasks:*"', () => {
    expect(filterGrantablePermissions(['tasks:*', 'signals:read'])).toEqual(['signals:read']);
  });

  test('strips unknown/made-up permission strings', () => {
    expect(filterGrantablePermissions(['admin:god-mode', 'signals:read'])).toEqual(['signals:read']);
  });

  test('keeps only permissions in the grantable allow-list, de-duplicated', () => {
    const result = filterGrantablePermissions(['signals:read', 'signals:read', 'tasks:propose', 'kb:write']);
    expect(result.sort()).toEqual(['kb:write', 'signals:read', 'tasks:propose'].sort());
  });

  test('every entry in the allow-list is a concrete resource:action pair, never a wildcard', () => {
    for (const p of GRANTABLE_BAP_PERMISSIONS) {
      expect(p).not.toContain('*');
    }
  });

  test('non-array input yields no permissions', () => {
    expect(filterGrantablePermissions(undefined)).toEqual([]);
    expect(filterGrantablePermissions('signals:read')).toEqual([]);
  });
});

describe('filterValidBusinessIds — no wildcard business-access self-assignment', () => {
  test('strips the "*" wildcard even when other valid IDs are present', () => {
    const result = filterValidBusinessIds(['*', BIZ_A]);
    expect(result).toEqual([BIZ_A]);
  });

  test('drops IDs that do not correspond to a real business', () => {
    const result = filterValidBusinessIds(['biz_does_not_exist', BIZ_A]);
    expect(result).toEqual([BIZ_A]);
  });

  test('a request for only "*" grants no business access at all', () => {
    expect(filterValidBusinessIds(['*'])).toEqual([]);
  });

  test('keeps multiple valid, explicit business IDs', () => {
    const result = filterValidBusinessIds([BIZ_A, BIZ_B]).sort();
    expect(result).toEqual([BIZ_A, BIZ_B].sort());
  });
});

describe('hasPermission — cross-tenant scoping (F-03/F-04/F-07 building block)', () => {
  test('an agent scoped to business A does not have permission on business B', () => {
    const agent = { permissions: JSON.stringify(['tasks:approve']), business_access: JSON.stringify([BIZ_A]) };
    expect(hasPermission(agent, 'tasks:approve', BIZ_A)).toBe(true);
    expect(hasPermission(agent, 'tasks:approve', BIZ_B)).toBe(false);
  });

  test('an agent without the permission is denied even for its own business', () => {
    const agent = { permissions: JSON.stringify(['signals:read']), business_access: JSON.stringify([BIZ_A]) };
    expect(hasPermission(agent, 'tasks:approve', BIZ_A)).toBe(false);
  });

  test('wildcard business_access ("*") still requires the specific permission', () => {
    const agent = { permissions: JSON.stringify(['signals:read']), business_access: JSON.stringify(['*']) };
    expect(hasPermission(agent, 'signals:read', BIZ_B)).toBe(true);
    expect(hasPermission(agent, 'tasks:approve', BIZ_B)).toBe(false);
  });
});
