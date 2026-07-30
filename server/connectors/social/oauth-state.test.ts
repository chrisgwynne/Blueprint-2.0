/**
 * TDD tests for secure OAuth state management.
 * RED first — these fail until oauth-state.ts is implemented.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import crypto from 'crypto';

// Force a known HMAC secret for deterministic tests
process.env.SESSION_SECRET = '0'.repeat(64);

import {
  createOAuthState,
  validateOAuthState,
  OAuthStateError,
  type OAuthStatePayload,
} from './oauth-state.js';

const basePayload: OAuthStatePayload = {
  businessId: 'biz_001',
  userId: 'user_001',
  type: 'social',
};

describe('createOAuthState', () => {
  test('returns a non-empty opaque string', async () => {
    const state = await createOAuthState(basePayload);
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(20);
  });

  test('different calls produce different states (nonce uniqueness)', async () => {
    const a = await createOAuthState(basePayload);
    const b = await createOAuthState(basePayload);
    expect(a).not.toBe(b);
  });
});

describe('validateOAuthState', () => {
  test('round-trip succeeds and returns original payload', async () => {
    const state = await createOAuthState(basePayload);
    const result = await validateOAuthState(state, basePayload.userId, basePayload.businessId);
    expect(result.businessId).toBe(basePayload.businessId);
    expect(result.userId).toBe(basePayload.userId);
    expect(result.type).toBe('social');
  });

  test('tampered signature is rejected', async () => {
    const state = await createOAuthState(basePayload);
    // Flip last character to tamper signature
    const tampered = state.slice(0, -4) + 'XXXX';
    await expect(validateOAuthState(tampered, basePayload.userId, basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('truncated state is rejected', async () => {
    const state = await createOAuthState(basePayload);
    await expect(validateOAuthState(state.slice(0, 20), basePayload.userId, basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('completely invalid state is rejected', async () => {
    await expect(validateOAuthState('not-valid-state', basePayload.userId, basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('expired state is rejected', async () => {
    const state = await createOAuthState(basePayload, -1); // -1 second TTL = already expired
    await expect(validateOAuthState(state, basePayload.userId, basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('replay is rejected after first validation (one-time use)', async () => {
    const state = await createOAuthState(basePayload);
    // First use succeeds
    await expect(validateOAuthState(state, basePayload.userId, basePayload.businessId)).resolves.toBeDefined();
    // Second use fails
    await expect(validateOAuthState(state, basePayload.userId, basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('user mismatch is rejected (session binding)', async () => {
    const state = await createOAuthState(basePayload);
    await expect(validateOAuthState(state, 'other_user', basePayload.businessId))
      .rejects.toThrow(OAuthStateError);
  });

  test('business mismatch is rejected (cross-business substitution)', async () => {
    const state = await createOAuthState(basePayload);
    await expect(validateOAuthState(state, basePayload.userId, 'other_biz'))
      .rejects.toThrow(OAuthStateError);
  });

  test('cross-business state substitution is rejected', async () => {
    const stateA = await createOAuthState({ ...basePayload, businessId: 'biz_A' });
    const stateB = await createOAuthState({ ...basePayload, businessId: 'biz_B' });
    // Using stateA but claiming it's for biz_B must fail
    await expect(validateOAuthState(stateA, basePayload.userId, 'biz_B'))
      .rejects.toThrow(OAuthStateError);
    // And stateB for biz_A too
    await expect(validateOAuthState(stateB, basePayload.userId, 'biz_A'))
      .rejects.toThrow(OAuthStateError);
  });

  test('missing SESSION_SECRET causes error on create', async () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    await expect(createOAuthState(basePayload)).rejects.toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = saved;
  });
});
