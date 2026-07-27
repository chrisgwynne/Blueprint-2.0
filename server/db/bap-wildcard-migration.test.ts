/**
 * Regression test for the retroactive wildcard-stripping migration
 * (db.ts: stripLegacyWildcardBapGrants). Fixing POST /register only closes
 * the door for *new* registrations — this migration handles bap_agents
 * rows that already hold a wildcard grant from before the fix.
 *
 * The migration itself runs once per database (guarded by a settings
 * marker) at module-load time, which already happened before this test
 * file runs — so this test seeds a row *as if* migration hadn't run yet,
 * re-invokes the same stripping logic directly against it, and asserts
 * the result. This avoids needing to reset the module-level marker
 * mid-test-run (db.ts is a singleton import, not re-instantiable).
 */
import { describe, test, expect } from 'bun:test';
import db from './db.js';

// Mirrors db.ts's stripLegacyWildcardBapGrants row-level logic exactly —
// re-implemented here rather than imported/exported from db.ts, since
// db.ts intentionally runs this as a private, one-shot IIFE at import
// time (not a reusable exported function) to keep the migration honestly
// "one-off" rather than something callable again by mistake.
function stripWildcards(permissions: unknown[], businessAccess: unknown[]): { permissions: unknown[]; business_access: unknown[] } {
  return {
    permissions: permissions.filter((p) => !(typeof p === 'string' && p.includes('*'))),
    business_access: businessAccess.filter((a) => a !== '*'),
  };
}

describe('BAP wildcard-stripping migration logic', () => {
  test('strips "*:*" and "resource:*" but keeps concrete permissions', () => {
    const result = stripWildcards(['*:*', 'signals:read', 'tasks:*', 'kb:write'], []);
    expect(result.permissions.sort()).toEqual(['kb:write', 'signals:read'].sort());
  });

  test('strips "*" business_access but keeps concrete business IDs', () => {
    const result = stripWildcards([], ['*', 'biz_a', 'biz_b']);
    expect(result.business_access.sort()).toEqual(['biz_a', 'biz_b'].sort());
  });

  test('a row with no wildcards at all is unaffected', () => {
    const result = stripWildcards(['signals:read', 'tasks:propose'], ['biz_a']);
    expect(result.permissions).toEqual(['signals:read', 'tasks:propose']);
    expect(result.business_access).toEqual(['biz_a']);
  });

  test('end-to-end: a pre-fix bap_agents row with full wildcard access is downgraded to empty grants when run through the same rule the startup migration applies', () => {
    // Seed a row exactly as the old, open /register would have created it.
    const id = 'agt_migration_test';
    db.prepare(`
      INSERT INTO bap_agents (id, name, api_key_hash, api_key_prefix, status, permissions, business_access, created_at)
      VALUES (?, 'Legacy Unrestricted Agent', 'x', 'bap_legacy', 'active', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET permissions = excluded.permissions, business_access = excluded.business_access
    `).run(id, JSON.stringify(['*:*']), JSON.stringify(['*']));

    const before = db.prepare('SELECT permissions, business_access FROM bap_agents WHERE id = ?').get(id) as
      { permissions: string; business_access: string };
    const beforePerms = JSON.parse(before.permissions);
    const beforeAccess = JSON.parse(before.business_access);
    expect(beforePerms).toContain('*:*');
    expect(beforeAccess).toContain('*');

    const { permissions, business_access } = stripWildcards(beforePerms, beforeAccess);
    db.prepare('UPDATE bap_agents SET permissions = ?, business_access = ? WHERE id = ?')
      .run(JSON.stringify(permissions), JSON.stringify(business_access), id);

    const after = db.prepare('SELECT permissions, business_access FROM bap_agents WHERE id = ?').get(id) as
      { permissions: string; business_access: string };
    expect(JSON.parse(after.permissions)).toEqual([]);
    expect(JSON.parse(after.business_access)).toEqual([]);

    db.prepare('DELETE FROM bap_agents WHERE id = ?').run(id);
  });

  test('the migration marker is recorded so it only runs once (real startup migration, not the re-implemented helper)', () => {
    const marker = db.prepare("SELECT value FROM settings WHERE key = 'migration_bap_strip_wildcards_v1'").get() as
      { value: string } | undefined;
    expect(marker).toBeDefined();
    const parsed = JSON.parse(marker!.value);
    expect(parsed).toHaveProperty('ran_at');
    expect(parsed).toHaveProperty('affected');
    expect(Array.isArray(parsed.affected)).toBe(true);
  });
});
