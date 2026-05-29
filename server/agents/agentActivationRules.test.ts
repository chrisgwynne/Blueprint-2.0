/**
 * Pure-logic tests for the activation rules: knowledge-area derivation, scope
 * matching, and the central evaluateActivation gate. No DB / no network.
 */
import { test, expect, describe } from 'bun:test';
import {
  deriveSignalKnowledgeAreas,
  intersectAreas,
  evaluateActivation,
  ROLE_SPECS,
  type ActivationContext,
} from './agentActivationRules.js';

function ctx(over: Partial<ActivationContext> = {}): ActivationContext {
  return {
    agentId: 'merchant',
    channel: 'signal',
    agentScope: ROLE_SPECS.merchant!.kb_scope,
    agentDataSources: ROLE_SPECS.merchant!.data_sources,
    triggerAreas: ['shopify', 'product'],
    triggerConnectorType: 'shopify',
    inCooldown: false,
    busy: false,
    duplicateScopeInFlight: false,
    isLive: true,
    ...over,
  };
}

describe('deriveSignalKnowledgeAreas', () => {
  test('maps shopify connector to commerce areas', () => {
    const areas = deriveSignalKnowledgeAreas({ connector_type: 'shopify', rule_id: 'shopify:low_stock' });
    expect(areas).toContain('shopify');
    expect(areas).toContain('inventory');
  });
  test('maps gsc connector to seo areas', () => {
    const areas = deriveSignalKnowledgeAreas({ connector_type: 'gsc', rule_id: 'gsc:indexing_drop' });
    expect(areas).toContain('indexing');
    expect(areas).toContain('gsc');
  });
  test('keyword scan picks up CWV from rule_id without connector', () => {
    const areas = deriveSignalKnowledgeAreas({ rule_id: 'perf:lcp_regression' });
    expect(areas).toContain('cwv');
    expect(areas).toContain('performance');
  });
  test('unknown signal falls back to general', () => {
    expect(deriveSignalKnowledgeAreas({ rule_id: 'totally_unknown_xyz' })).toEqual(['general']);
  });
});

describe('intersectAreas', () => {
  test('returns overlap only', () => {
    expect(intersectAreas(['a', 'b', 'c'], ['b', 'c', 'd']).sort()).toEqual(['b', 'c']);
  });
  test('empty when disjoint', () => {
    expect(intersectAreas(['a'], ['b'])).toEqual([]);
  });
});

describe('evaluateActivation — scope gating (the core fix)', () => {
  test('signal activates an agent ONLY when areas intersect scope', () => {
    const d = evaluateActivation(ctx({ triggerAreas: ['shopify', 'product'] }));
    expect(d.allowed).toBe(true);
    expect(d.matchedAreas).toContain('shopify');
  });

  test('signal does NOT activate an out-of-scope agent (seo signal → merchant)', () => {
    const d = evaluateActivation(ctx({ triggerAreas: ['gsc', 'indexing', 'ranking'] }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('out_of_scope');
  });

  test('"some signal exists" with no derivable area does not activate', () => {
    const d = evaluateActivation(ctx({ triggerAreas: [] }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('out_of_scope');
  });
});

describe('evaluateActivation — guardrails', () => {
  test('cooldown blocks activation (no endless retry)', () => {
    const d = evaluateActivation(ctx({ inCooldown: true }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('in_cooldown');
  });

  test('busy agent will not start a second task', () => {
    const d = evaluateActivation(ctx({ busy: true }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('already_busy');
  });

  test('duplicate in-flight scope is refused', () => {
    const d = evaluateActivation(ctx({ duplicateScopeInFlight: true }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('duplicate_scope');
  });

  test('pre-hire / archived agents never activate', () => {
    const d = evaluateActivation(ctx({ isLive: false }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('not_live');
  });
});

describe('evaluateActivation — channels', () => {
  test('manual bypasses scope matching but respects cooldown', () => {
    const allowed = evaluateActivation(ctx({ channel: 'manual', triggerAreas: [] }));
    expect(allowed.allowed).toBe(true);
    const blocked = evaluateActivation(ctx({ channel: 'manual', triggerAreas: [], inCooldown: true }));
    expect(blocked.allowed).toBe(false);
  });

  test('escalation REQUIRES evidence', () => {
    const noEv = evaluateActivation(ctx({ channel: 'escalation', hasEvidence: false }));
    expect(noEv.allowed).toBe(false);
    expect(noEv.code).toBe('no_evidence');
    const withEv = evaluateActivation(ctx({ channel: 'escalation', hasEvidence: true }));
    expect(withEv.allowed).toBe(true);
  });

  test('escalation must still be in-scope', () => {
    const d = evaluateActivation(ctx({ channel: 'escalation', hasEvidence: true, triggerAreas: ['revenue', 'finance'] }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('out_of_scope');
  });

  test('scheduled task for the role is always allowed (in budget)', () => {
    const d = evaluateActivation(ctx({ channel: 'schedule', triggerAreas: [] }));
    expect(d.allowed).toBe(true);
  });
});
