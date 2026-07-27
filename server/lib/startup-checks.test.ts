/**
 * Regression tests for F-18: Blueprint must refuse to start in production
 * with a default/unset admin password.
 */
import { describe, test, expect } from 'bun:test';
import { isProductionAdminPasswordUnsafe } from './startup-checks.ts';

describe('isProductionAdminPasswordUnsafe', () => {
  test('flags the documented default password ("changeme") in production', () => {
    expect(isProductionAdminPasswordUnsafe('production', 'changeme')).toBe(true);
  });

  test('flags an unset password in production', () => {
    expect(isProductionAdminPasswordUnsafe('production', undefined)).toBe(true);
    expect(isProductionAdminPasswordUnsafe('production', '')).toBe(true);
  });

  test('does not flag a non-default password in production', () => {
    expect(isProductionAdminPasswordUnsafe('production', 'a-real-strong-password-123')).toBe(false);
  });

  test('does not flag the default password outside production (development/test)', () => {
    expect(isProductionAdminPasswordUnsafe('development', 'changeme')).toBe(false);
    expect(isProductionAdminPasswordUnsafe(undefined, 'changeme')).toBe(false);
    expect(isProductionAdminPasswordUnsafe('test', undefined)).toBe(false);
  });
});
