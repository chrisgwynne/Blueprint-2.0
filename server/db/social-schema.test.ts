/**
 * Schema migration tests for social publishing tables.
 * Verifies that social_posts and oauth_nonces are created by the startup
 * migrations in db.ts (no lazy-init required).
 */
import { describe, test, expect } from 'bun:test';
import db from './db.js';

describe('social_posts table', () => {
  test('exists after DB initialisation', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='social_posts'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe('social_posts');
  });

  test('has required columns', () => {
    const cols = db.prepare("PRAGMA table_info('social_posts')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('business_id');
    expect(names).toContain('connector_id');
    expect(names).toContain('platform');
    expect(names).toContain('status');
    expect(names).toContain('scheduled_at');
    expect(names).toContain('attempt_count');
    expect(names).toContain('approved_caption');
    expect(names).toContain('permalink');
  });

  test('has an index on (business_id, status)', () => {
    const indexes = db.prepare("PRAGMA index_list('social_posts')").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('business_status'))).toBe(true);
  });

  test('has a scheduled_at index for worker efficiency', () => {
    const indexes = db.prepare("PRAGMA index_list('social_posts')").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('scheduled'))).toBe(true);
  });
});

describe('oauth_nonces table', () => {
  test('exists after DB initialisation', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_nonces'",
    ).get() as { name: string } | null;
    expect(row?.name).toBe('oauth_nonces');
  });

  test('has required columns', () => {
    const cols = db.prepare("PRAGMA table_info('oauth_nonces')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('nonce');
    expect(names).toContain('expires_at');
    expect(names).toContain('used_at');
    expect(names).toContain('created_at');
  });

  test('nonce column is the primary key', () => {
    const cols = db.prepare("PRAGMA table_info('oauth_nonces')").all() as Array<{ name: string; pk: number }>;
    const noncePk = cols.find((c) => c.name === 'nonce')?.pk;
    expect(noncePk).toBeGreaterThan(0);
  });
});
